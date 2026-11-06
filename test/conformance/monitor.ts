import { methods, type ProtocolVersion, validate } from "./acp-schema.js";

/**
 * Watches one ACP connection from the client's side and records every way the
 * traffic breaks ACP: schema violations, in both directions, plus the
 * protocol rules a schema cannot express. The protocol version is the one the
 * client's `initialize` asks for (the agent may not answer with a newer one):
 * ACP v1, or the stable feature set of the v2 draft.
 *
 * Feed it every frame the client writes (`fromClient`) and every frame the
 * agent writes (`fromAgent`), in wire order. Client frames are checked too, so
 * a test cannot pass by driving the adapter with a payload no real client
 * would send.
 */
export interface Violation {
	direction: "agent→client" | "client→agent";
	rule: string;
	detail: string;
}

type Frame = Record<string, unknown>;
type Id = string | number;

/** v1 session updates v2 replaced: tool calls are created by `tool_call_update`, plans by `plan_update`. */
const V1_ONLY_UPDATES = new Set(["tool_call", "plan", "current_mode_update"]);

/** v1 session updates and requests a client may only receive after advertising a capability. */
const UPDATE_CAPABILITIES: Record<string, (caps: Capabilities) => boolean> = {
	notice: (caps) => caps.session?.notices != null,
	compaction_update: (caps) => caps.session?.compaction != null,
	compaction_summary_chunk: (caps) => caps.session?.compaction != null,
};

interface Capabilities {
	fs?: { readTextFile?: boolean; writeTextFile?: boolean };
	terminal?: boolean;
	session?: { notices?: unknown; compaction?: unknown } | null;
	elicitation?: { form?: unknown; url?: unknown } | null;
}

export class ConformanceMonitor {
	readonly violations: Violation[] = [];
	/** Every schema definition a frame was checked against, for coverage. */
	readonly checked = new Set<string>();

	#capabilities: Capabilities = {};
	#version: ProtocolVersion = 1;
	#initialized = false;
	/** v2: user message ids echoed per session, and prompt answers still waiting for their echo. */
	#userMessages = new Map<string, Set<string>>();
	#awaitingEcho = new Map<string, string>();
	/** v2: `session/resume` requests in flight, and whether a state update came for each. */
	#resumes = new Map<Id, { sessionId: string; stateSent: boolean }>();
	/** Client requests awaiting a response: id -> method (and params, for session bookkeeping). */
	#clientRequests = new Map<Id, { method: string; params: Frame }>();
	/** Agent requests awaiting the client's response: id -> method. */
	#agentRequests = new Map<Id, string>();
	/** Every agent request id ever seen, answered or not. */
	readonly #seenAgentRequestIds = new Set<Id>();
	/** Sessions the client knows about, so the agent may address them. */
	#sessions = new Set<string>();
	/** Sessions the client closed or deleted. */
	#ended = new Set<string>();
	/** Tool calls announced with `tool_call`, per session. */
	#toolCalls = new Map<string, Set<string>>();

	fromClient(frame: unknown): void {
		const message = this.#frame("client→agent", frame);
		if (!message) return;

		if (typeof message.method === "string" && "id" in message) {
			const id = message.id as Id;
			const params = (message.params ?? {}) as Frame;
			if (message.method === "initialize") {
				const requested = (params as { protocolVersion?: unknown }).protocolVersion;
				this.#version = typeof requested === "number" && requested >= 2 ? 2 : 1;
				const capabilities = this.#version === 2 ? params.capabilities : params.clientCapabilities;
				this.#capabilities = (capabilities ?? {}) as Capabilities;
			}
			this.#check("client→agent", this.#methods.agentRequests, message.method, params, "request params");
			this.#clientRequests.set(id, { method: message.method, params });
			if (this.#version === 2 && message.method === "session/resume" && typeof params.sessionId === "string") {
				this.#resumes.set(id, { sessionId: params.sessionId, stateSent: false });
			}
			// The client names these sessions itself, so it knows them already.
			if (
				(message.method === "session/load" || message.method === "session/resume") &&
				typeof params.sessionId === "string"
			) {
				this.#openSession(params.sessionId);
			}
		} else if (typeof message.method === "string") {
			this.#check("client→agent", this.#methods.agentNotifications, message.method, message.params ?? {}, "notification params");
		} else if ("id" in message) {
			const method = this.#agentRequests.get(message.id as Id);
			if (method === undefined) {
				this.#violation("client→agent", "response-id", `response to unknown agent request ${String(message.id)}`);
			} else if ("result" in message) {
				this.#check("client→agent", this.#methods.clientResponses, method, message.result, "response result");
			}
			this.#agentRequests.delete(message.id as Id);
		}
	}

	fromAgent(frame: unknown): void {
		const message = this.#frame("agent→client", frame);
		if (!message) return;

		const isRequest = typeof message.method === "string" && "id" in message;
		const isNotification = typeof message.method === "string" && !("id" in message);
		if ((isRequest || isNotification) && !this.#initialized) {
			this.#violation("agent→client", "before-initialize", `${String(message.method)} sent before initialize completed`);
		}

		if (isRequest) {
			const method = message.method as string;
			const params = (message.params ?? {}) as Frame;
			if (this.#agentRequests.has(message.id as Id)) {
				this.#violation("agent→client", "request-id", `request id ${String(message.id)} reused while still pending`);
			}
			this.#agentRequests.set(message.id as Id, method);
			if (!method.startsWith("_") && !this.#methods.clientRequests.has(method)) {
				this.#violation("agent→client", "unknown-method", `request for unknown client method ${method}`);
				return;
			}
			this.#check("agent→client", this.#methods.clientRequests, method, params, "request params");
			this.#checkClientMethodAllowed(method, params);
			if (typeof params.sessionId === "string") this.#checkSessionAddressable(method, params.sessionId);
			if (method === "session/request_permission" && this.#version === 1) this.#checkToolCallKnown(params, "toolCall");
			return;
		}

		if (isNotification) {
			const method = message.method as string;
			const params = (message.params ?? {}) as Frame;
			if (!method.startsWith("_") && !this.#methods.clientNotifications.has(method)) {
				this.#violation("agent→client", "unknown-method", `notification for unknown method ${method}`);
				return;
			}
			this.#check("agent→client", this.#methods.clientNotifications, method, params, "notification params");
			if (method === "session/update") this.#checkSessionUpdate(params);
			if (method === "$/cancel_request" && !this.#agentRequestKnown(params.requestId)) {
				this.#violation("agent→client", "cancel-request", `$/cancel_request for a request the agent never sent`);
			}
			return;
		}

		// A response.
		if (!("id" in message)) {
			this.#violation("agent→client", "framing", "message is neither request, notification nor response");
			return;
		}
		const pending = this.#clientRequests.get(message.id as Id);
		if (!pending) {
			this.#violation("agent→client", "response-id", `response to unknown or already-answered request ${String(message.id)}`);
			return;
		}
		this.#clientRequests.delete(message.id as Id);

		const resume = this.#resumes.get(message.id as Id);
		this.#resumes.delete(message.id as Id);
		if ("error" in message) {
			const errors = validate(this.#version, "Error", message.error);
			this.checked.add("Error");
			if (errors.length > 0) this.#violation("agent→client", "schema", `error for ${pending.method}: ${errors.join("; ")}`);
			return;
		}
		if (!("result" in message)) {
			this.#violation("agent→client", "framing", `response to ${pending.method} has neither result nor error`);
			return;
		}
		this.#check("agent→client", this.#methods.agentResponses, pending.method, message.result, "response result");
		if (resume && !resume.stateSent) {
			this.#violation("agent→client", "state", `session/resume of ${resume.sessionId} answered without a state_update first`);
		}
		this.#afterResponse(pending.method, pending.params, message.result as Frame, message.id as Id);
	}

	/**
	 * Rules that can only be judged once the exchange is over: every v2 prompt
	 * the agent accepted must have been echoed as a user message.
	 */
	finish(): void {
		for (const [messageId, sessionId] of this.#awaitingEcho) {
			this.#violation("agent→client", "user-message", `prompt ${messageId} in session ${sessionId} was accepted but never echoed as a user message`);
		}
		this.#awaitingEcho.clear();
	}

	get #methods() {
		return methods[this.#version];
	}

	#afterResponse(method: string, params: Frame, result: Frame, id: Id): void {
		switch (method) {
			case "initialize": {
				this.#initialized = true;
				const requested = (params as { protocolVersion?: number }).protocolVersion ?? 0;
				const answered = (result as { protocolVersion?: number }).protocolVersion ?? 0;
				if (answered > requested) {
					this.#violation("agent→client", "protocol-version", `agent answered version ${answered} to a request for ${requested}`);
				}
				return;
			}
			case "session/new":
				if (typeof result.sessionId === "string") this.#openSession(result.sessionId);
				return;
			case "session/prompt":
				if (this.#version === 2 && typeof result.messageId === "string" && typeof params.sessionId === "string") {
					if (!this.#userMessagesOf(params.sessionId).has(result.messageId)) {
						this.#awaitingEcho.set(result.messageId, params.sessionId);
					}
				}
				return;
			case "session/close":
			case "session/delete":
				if (typeof params.sessionId === "string") {
					this.#sessions.delete(params.sessionId);
					this.#ended.add(params.sessionId);
				}
				return;
		}
	}

	#checkSessionUpdate(params: Frame): void {
		const sessionId = params.sessionId;
		const update = params.update as Frame | undefined;
		if (typeof sessionId !== "string" || !update) return;
		this.#checkSessionAddressable(`session/update (${String(update.sessionUpdate)})`, sessionId);

		const kind = String(update.sessionUpdate);
		if (this.#version === 2) return this.#checkV2SessionUpdate(sessionId, kind, update);
		const allowed = UPDATE_CAPABILITIES[kind];
		if (allowed && !allowed(this.#capabilities)) {
			this.#violation("agent→client", "capability", `${kind} sent to a client that did not advertise support for it`);
		}

		const calls = this.#toolCallsOf(sessionId);
		if (kind === "tool_call" && typeof update.toolCallId === "string") calls.add(update.toolCallId);
		if (kind === "tool_call_update") this.#checkToolCallKnown({ sessionId, toolCall: update }, "toolCall");
	}

	#checkV2SessionUpdate(sessionId: string, kind: string, update: Frame): void {
		if (V1_ONLY_UPDATES.has(kind)) {
			this.#violation("agent→client", "version", `${kind} is an ACP v1 update; v2 has no such update`);
		}
		if ((kind === "user_message" || kind === "user_message_chunk") && typeof update.messageId === "string") {
			this.#userMessagesOf(sessionId).add(update.messageId);
			this.#awaitingEcho.delete(update.messageId);
		}
		if (kind === "state_update") {
			for (const resume of this.#resumes.values()) if (resume.sessionId === sessionId) resume.stateSent = true;
		}
	}

	#userMessagesOf(sessionId: string): Set<string> {
		let ids = this.#userMessages.get(sessionId);
		if (!ids) {
			ids = new Set();
			this.#userMessages.set(sessionId, ids);
		}
		return ids;
	}

	/** A tool call update must refer to a tool call the client was told about. */
	#checkToolCallKnown(params: Frame, field: string): void {
		const sessionId = params.sessionId;
		const toolCallId = (params[field] as Frame | undefined)?.toolCallId;
		if (typeof sessionId !== "string" || typeof toolCallId !== "string") return;
		if (!this.#toolCallsOf(sessionId).has(toolCallId)) {
			this.#violation("agent→client", "tool-call", `update for tool call ${toolCallId}, which was never announced with tool_call`);
		}
	}

	#checkSessionAddressable(what: string, sessionId: string): void {
		if (this.#ended.has(sessionId) && !this.#sessions.has(sessionId)) {
			this.#violation("agent→client", "session", `${what} for session ${sessionId} after the client closed or deleted it`);
		} else if (!this.#sessions.has(sessionId)) {
			this.#violation("agent→client", "session", `${what} for session ${sessionId} before the client knew it existed`);
		}
	}

	/** Client methods the agent may only call when the client advertised them. */
	#checkClientMethodAllowed(method: string, params: Frame): void {
		const caps = this.#capabilities;
		const allowed =
			method === "fs/read_text_file"
				? caps.fs?.readTextFile === true
				: method === "fs/write_text_file"
					? caps.fs?.writeTextFile === true
					: method.startsWith("terminal/")
						? caps.terminal === true
						: method === "elicitation/create"
							? params.mode === "url"
								? caps.elicitation?.url != null
								: caps.elicitation?.form != null
							: true;
		if (!allowed) this.#violation("agent→client", "capability", `${method} sent to a client that did not advertise it`);
	}

	#agentRequestKnown(requestId: unknown): boolean {
		// Answered requests are forgotten, but cancelling one the client already
		// answered is a harmless race, so only ids never seen at all count.
		return typeof requestId === "string" || typeof requestId === "number"
			? this.#seenAgentRequestIds.has(requestId)
			: false;
	}

	#openSession(sessionId: string): void {
		this.#sessions.add(sessionId);
		this.#ended.delete(sessionId);
		// A reopened session replays or starts over; earlier tool calls no longer count.
		this.#toolCalls.set(sessionId, new Set());
	}

	#toolCallsOf(sessionId: string): Set<string> {
		let calls = this.#toolCalls.get(sessionId);
		if (!calls) {
			calls = new Set();
			this.#toolCalls.set(sessionId, calls);
		}
		return calls;
	}

	#frame(direction: Violation["direction"], frame: unknown): Frame | null {
		if (typeof frame !== "object" || frame === null || Array.isArray(frame)) {
			this.#violation(direction, "framing", `not a JSON-RPC object: ${JSON.stringify(frame)?.slice(0, 80)}`);
			return null;
		}
		const message = frame as Frame;
		if (message.jsonrpc !== "2.0") this.#violation(direction, "framing", `jsonrpc is ${JSON.stringify(message.jsonrpc)}, not "2.0"`);
		if ("id" in message && typeof message.id !== "string" && typeof message.id !== "number") {
			this.#violation(direction, "framing", `id ${JSON.stringify(message.id)} is not a string or number`);
		}
		if (direction === "agent→client" && typeof message.method === "string" && "id" in message) {
			this.#seenAgentRequestIds.add(message.id as Id);
		}
		return message;
	}

	#check(
		direction: Violation["direction"],
		index: Map<string, string>,
		method: string,
		value: unknown,
		what: string,
	): void {
		const definition = index.get(method);
		if (!definition) {
			// Extension methods (leading underscore) are outside the schema.
			if (!method.startsWith("_")) this.#violation(direction, "unknown-method", `${what} for unknown method ${method}`);
			return;
		}
		this.checked.add(definition);
		const errors = validate(this.#version, definition, value);
		if (errors.length > 0) this.#violation(direction, "schema", `${method} ${what} is not a valid ${definition}: ${errors.join("; ")}`);
	}

	#violation(direction: Violation["direction"], rule: string, detail: string): void {
		this.violations.push({ direction, rule, detail });
	}
}

/** One line per violation, for assertion messages. */
export function describeViolations(violations: readonly Violation[]): string {
	return violations.map((v) => `[${v.rule}] ${v.direction}: ${v.detail}`).join("\n");
}
