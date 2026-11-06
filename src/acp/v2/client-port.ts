import type * as v1 from "@agentclientprotocol/sdk";
import * as v2 from "@agentclientprotocol/sdk/experimental/v2";
import type {
	ClientFeatures,
	ClientPort,
	ForegroundState,
	PermissionOutcome,
	PermissionPrompt,
	SessionUpdate,
	TerminalEvent,
} from "../client-port.js";
import { toV2Commands, toV2ConfigOptions, toV2Locations, toV2ToolCallContent } from "./translate.js";

interface SessionState {
	/** The foreground state last reported to the client. */
	state: "idle" | "running" | "requires_action";
	/** Permission prompts and elicitations the client has not answered yet. */
	openRequests: number;
	/** Aborted by `session/cancel` and `session/close` to withdraw open requests. */
	requests: AbortController;
	/** After `session/close`, nothing more is sent for the session. */
	closed: boolean;
	/** Set while `session/resume` replays history; holds the message ids replayed so far. */
	replayed: Set<string> | null;
}

/**
 * ACP v2: carries the core's v1 messages to a v2 client.
 *
 * Each v1 update becomes zero or more v2 updates, sent in order without
 * awaiting in between, so they keep their place among everything else the
 * core sends. Beyond translating, the port keeps what v2 adds per session: the
 * foreground state (`state_update`), withdrawing open requests on cancel, and
 * the silence after `session/close`.
 */
export class V2ClientPort implements ClientPort {
	features: ClientFeatures = V2ClientPort.features(undefined);

	#sessions = new Map<string, SessionState>();

	constructor(private readonly client: v2.AgentContext) {}

	/**
	 * What a v2 client supports. v2 has no client file system; notices,
	 * compaction updates and display terminals need no capability, so every v2
	 * client gets them; form elicitation is the one thing a client advertises.
	 */
	static features(capabilities: v2.ClientCapabilities | null | undefined): ClientFeatures {
		return {
			readTextFile: false,
			formElicitation: capabilities?.elicitation?.form != null,
			notices: true,
			compactionUpdates: true,
			displayTerminals: true,
		};
	}

	// ==========================================================================
	// Session lifecycle, driven by the v2 front end
	// ==========================================================================

	/** A session the client knows (again), after `session/new` or `session/resume`. */
	open(sessionId: string): void {
		this.#session(sessionId).closed = false;
	}

	/** After `session/close` or `session/delete`: nothing more goes out for the session. */
	close(sessionId: string): void {
		this.#session(sessionId).closed = true;
	}

	/** Withdraw the session's open permission prompts and elicitations. */
	withdrawRequests(sessionId: string): void {
		const session = this.#session(sessionId);
		session.requests.abort();
		session.requests = new AbortController();
	}

	/** Run a history replay: replayed messages replace any copy the client holds. */
	async replay<T>(sessionId: string, run: () => Promise<T>): Promise<T> {
		const session = this.#session(sessionId);
		session.replayed = new Set();
		try {
			return await run();
		} finally {
			session.replayed = null;
		}
	}

	/** Echo a prompt the agent inserted, under the id `session/prompt` answers with. */
	userMessage(sessionId: string, messageId: string, content: v2.ContentBlock[]): Promise<void> {
		return this.#send(sessionId, [{ sessionUpdate: "user_message", messageId, content }]);
	}

	/** Report the session's foreground state; an idle without stop reason is a resync snapshot. */
	foreground(sessionId: string, state: ForegroundState | { state: "idle" }): Promise<void> {
		const session = this.#session(sessionId);
		session.state = state.state;
		if (state.state === "running") return this.#send(sessionId, [{ sessionUpdate: "state_update", state: "running" }]);
		if (!("stopReason" in state)) return this.#send(sessionId, [{ sessionUpdate: "state_update", state: "idle" }]);
		return this.#send(sessionId, [
			{
				sessionUpdate: "state_update",
				state: "idle",
				...(state.stopReason === "error"
					? { stopReason: "error" as const, error: "error" in state ? state.error : null }
					: { stopReason: state.stopReason }),
			} as v2.SessionUpdate,
		]);
	}

	// ==========================================================================
	// ClientPort
	// ==========================================================================

	update(sessionId: string, update: SessionUpdate): Promise<void> {
		return this.#send(sessionId, this.#translate(sessionId, update));
	}

	terminal(sessionId: string, event: TerminalEvent): Promise<void> {
		switch (event.type) {
			case "open":
				return this.#send(sessionId, [
					{
						sessionUpdate: "terminal_update",
						terminalId: event.terminalId,
						cwd: event.cwd,
						...(event.command ? { command: event.command } : {}),
					},
				]);
			case "output":
				return this.#send(sessionId, [
					{ sessionUpdate: "terminal_output_chunk", terminalId: event.terminalId, data: base64(event.data) },
				]);
			case "exit":
				return this.#send(sessionId, [
					{
						sessionUpdate: "terminal_update",
						terminalId: event.terminalId,
						exitStatus: event.exitCode === null ? {} : { exitCode: event.exitCode },
					},
				]);
		}
	}

	unpromptedRun(sessionId: string, state: ForegroundState): Promise<void> {
		return this.foreground(sessionId, state);
	}

	async requestPermission(prompt: PermissionPrompt, options?: v1.SendRequestOptions): Promise<PermissionOutcome> {
		const offered = new Set(prompt.options.map((option) => option.optionId));
		const response = await this.#whileBlocking(prompt.sessionId, options, (requestOptions) =>
			this.client.request(
				v2.methods.client.session.requestPermission,
				{
					sessionId: prompt.sessionId,
					title: prompt.title,
					...(prompt.description ? { description: prompt.description } : {}),
					// Only the id: the subject updates the stored tool call, and the
					// prompt's title is not the tool call's.
					...(prompt.toolCall ? { subject: { type: "tool_call", toolCall: { toolCallId: prompt.toolCall.toolCallId } } } : {}),
					options: prompt.options as v2.PermissionOption[],
				},
				requestOptions,
			),
		).catch(() => undefined);
		const outcome = response?.outcome;
		// An option that was not offered, or an outcome this agent does not know, is no approval.
		if (outcome?.outcome === "selected" && "optionId" in outcome && offered.has(outcome.optionId as string)) {
			return { outcome: "selected", optionId: outcome.optionId as string };
		}
		return { outcome: "cancelled" };
	}

	async elicit(request: v1.CreateElicitationRequest, options?: v1.SendRequestOptions): Promise<v1.CreateElicitationResponse> {
		const sessionId = "sessionId" in request && typeof request.sessionId === "string" ? request.sessionId : undefined;
		const response: v2.CreateElicitationResponse = await this.#whileBlocking(sessionId, options, (requestOptions) =>
			this.client.request(
				v2.methods.client.elicitation.create,
				request as unknown as v2.CreateElicitationRequest,
				requestOptions,
			),
		);
		// v2 asks for an unknown action to be handled as a cancel.
		return response.action === "accept" || response.action === "decline"
			? (response as v1.CreateElicitationResponse)
			: { action: "cancel" };
	}

	async readTextFile(): Promise<string> {
		throw new Error("ACP v2 clients have no file system methods");
	}

	// ==========================================================================
	// Internals
	// ==========================================================================

	/**
	 * Send a request the session's work waits on: report `requires_action`
	 * while it is open, and withdraw it when the session is cancelled or closed.
	 */
	async #whileBlocking<T>(
		sessionId: string | undefined,
		options: v1.SendRequestOptions | undefined,
		send: (options: v1.SendRequestOptions) => Promise<T>,
	): Promise<T> {
		if (sessionId === undefined) return send({ ...options });
		const session = this.#session(sessionId);
		const signals = [session.requests.signal, options?.cancellationSignal].filter((s): s is AbortSignal => s != null);
		const requestOptions: v1.SendRequestOptions = { ...options, cancellationSignal: AbortSignal.any(signals), stopWaitingOnCancel: true };

		// Requests outside foreground work do not change the session's state.
		const blocking = session.state !== "idle";
		if (blocking) {
			session.openRequests++;
			if (session.state === "running") {
				session.state = "requires_action";
				void this.#send(sessionId, [{ sessionUpdate: "state_update", state: "requires_action" }]);
			}
		}
		try {
			return await send(requestOptions);
		} finally {
			if (blocking) {
				session.openRequests--;
				// Back to work, unless the work ended while the request was open.
				if (session.openRequests === 0 && session.state === "requires_action") {
					session.state = "running";
					void this.#send(sessionId, [{ sessionUpdate: "state_update", state: "running" }]);
				}
			}
		}
	}

	#translate(sessionId: string, update: SessionUpdate): v2.SessionUpdate[] {
		const session = this.#session(sessionId);
		switch (update.sessionUpdate) {
			case "user_message_chunk":
			case "agent_message_chunk":
			case "agent_thought_chunk": {
				const messageId = update.messageId ?? `${update.sessionUpdate}-${randomId()}`;
				const content = update.content as v2.ContentBlock;
				// A replayed message replaces whatever copy of it the client holds;
				// later chunks of it append as usual.
				if (session.replayed && !session.replayed.has(messageId)) {
					session.replayed.add(messageId);
					const whole = {
						user_message_chunk: "user_message",
						agent_message_chunk: "agent_message",
						agent_thought_chunk: "agent_thought",
					} as const;
					return [{ sessionUpdate: whole[update.sessionUpdate], messageId, content: [content] } as v2.SessionUpdate];
				}
				return [{ sessionUpdate: update.sessionUpdate, messageId, content } as v2.SessionUpdate];
			}

			case "tool_call":
			case "tool_call_update":
				return this.#translateToolCall(update);

			case "available_commands_update":
				return [{ sessionUpdate: "available_commands_update", availableCommands: toV2Commands(update.availableCommands) }];

			case "config_option_update":
				return [{ sessionUpdate: "config_option_update", configOptions: toV2ConfigOptions(update.configOptions) }];

			case "session_info_update":
			case "usage_update":
			case "notice":
			case "compaction_update":
			case "compaction_summary_chunk":
				return [update as v2.SessionUpdate];

			default:
				// v1-only updates (modes, v1 plans): the core sends none of them.
				return [];
		}
	}

	/** v1 `tool_call`/`tool_call_update` -> a v2 upsert. */
	#translateToolCall(update: Extract<SessionUpdate, { sessionUpdate: "tool_call" | "tool_call_update" }>): v2.SessionUpdate[] {
		const { sessionUpdate: _kind, content, locations, ...fields } = update;
		// In v2 `null` clears a field, where the core's v1 updates use it for
		// "nothing to say": drop those.
		const patch: Record<string, unknown> = {};
		for (const [key, value] of Object.entries(fields)) if (value != null) patch[key] = value;
		if (content != null) patch.content = toV2ToolCallContent(content);
		if (locations != null) patch.locations = toV2Locations(locations);
		return [{ sessionUpdate: "tool_call_update", ...patch } as v2.SessionUpdate];
	}

	#send(sessionId: string, updates: v2.SessionUpdate[]): Promise<void> {
		if (updates.length === 0 || this.#session(sessionId).closed) return Promise.resolve();
		// All handed to the SDK before anything is awaited, so they keep their order.
		const sent = updates.map((update) => this.client.notify(v2.methods.client.session.update, { sessionId, update }));
		return Promise.all(sent).then(() => undefined);
	}

	#session(sessionId: string): SessionState {
		let session = this.#sessions.get(sessionId);
		if (!session) {
			session = {
				state: "idle",
				openRequests: 0,
				requests: new AbortController(),
				closed: false,
				replayed: null,
			};
			this.#sessions.set(sessionId, session);
		}
		return session;
	}
}

function base64(text: string): string {
	return Buffer.from(text, "utf8").toString("base64");
}

function randomId(): string {
	return Math.random().toString(36).slice(2, 10);
}
