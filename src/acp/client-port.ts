import {
	type AgentContext,
	type ClientCapabilities,
	type CreateElicitationRequest,
	type CreateElicitationResponse,
	methods,
	type PermissionOption,
	type PromptResponse,
	type SendRequestOptions,
	type SessionNotification,
} from "@agentclientprotocol/sdk";

/** An ACP v1 `session/update` payload: the vocabulary the adapter's core speaks. */
export type SessionUpdate = SessionNotification["update"];

/** A question a pi extension dialog puts to the user, answered by picking an option. */
export interface PermissionPrompt {
	sessionId: string;
	/** pi's id for the dialog; names a tool call created just to anchor it. */
	dialogId: string;
	/** What is being asked: the dialog's title. */
	title: string;
	/** The dialog's message, if it has one beyond the title. */
	description?: string;
	/** The tool call running when the dialog opened, if any. */
	toolCall?: { toolCallId: string; title?: string };
	options: PermissionOption[];
}

export type PermissionOutcome = { outcome: "selected"; optionId: string } | { outcome: "cancelled" };

/**
 * What happens to a display terminal: one the client only shows, for a
 * command pi runs itself. ACP v2 has these as `terminal_update` and
 * `terminal_output_chunk`; v1 has nothing equivalent.
 */
export type TerminalEvent =
	| { type: "open"; terminalId: string; cwd: string; command?: string }
	/** Output to append to what the terminal shows. */
	| { type: "output"; terminalId: string; data: string }
	| { type: "exit"; terminalId: string; exitCode: number | null };

/**
 * The client features the core adapts to. Each port derives them from what
 * its protocol version lets a client advertise.
 */
export interface ClientFeatures {
	/** The client serves `fs/read_text_file`, so diffs can snapshot unsaved buffers. */
	readTextFile: boolean;
	/** The client renders form elicitations, so extension dialogs can ask for text. */
	formElicitation: boolean;
	/** The client shows `notice` updates; otherwise status lines go into the transcript. */
	notices: boolean;
	/** The client tracks `compaction_update`s; otherwise compactions are reported as status lines. */
	compactionUpdates: boolean;
	/**
	 * Shell output goes to a display terminal (see {@link ClientPort.terminal}),
	 * which the tool call refers to with `{ type: "terminal" }` content, instead
	 * of being text content on the tool call.
	 */
	displayTerminals: boolean;
}

/** Foreground work as ACP v2 state updates report it. */
export type ForegroundState =
	| { state: "running" }
	| { state: "idle"; stopReason: PromptResponse["stopReason"] }
	| { state: "idle"; stopReason: "error"; error: { code: number; message: string } };

/**
 * Everything the adapter's core needs from the ACP client.
 *
 * The core speaks ACP v1. Each protocol version has a port that carries those
 * messages to the client in its own terms: {@link V1ClientPort} passes them
 * through, and the v2 port (`./v2/client-port.ts`) translates them.
 */
export interface ClientPort {
	readonly features: ClientFeatures;
	/** Only called when `features.displayTerminals` is set. */
	terminal(sessionId: string, event: TerminalEvent): Promise<void>;
	update(sessionId: string, update: SessionUpdate): Promise<void>;
	/**
	 * Ask the user to choose an option. Anything but a selection, including a
	 * failed or withdrawn request, comes back as `cancelled`.
	 */
	requestPermission(prompt: PermissionPrompt, options?: SendRequestOptions): Promise<PermissionOutcome>;
	elicit(request: CreateElicitationRequest, options?: SendRequestOptions): Promise<CreateElicitationResponse>;
	/** A file as the client sees it; only called when `features.readTextFile` is set. */
	readTextFile(sessionId: string, path: string): Promise<string>;
	/**
	 * pi's foreground work started or ended: a prompt turn (once pi has taken
	 * the prompt), or a run nobody prompted for, such as a queued follow-up.
	 */
	foreground(sessionId: string, state: ForegroundState): Promise<void>;
}

/** ACP v1: the core's messages go to the client unchanged. */
export class V1ClientPort implements ClientPort {
	features: ClientFeatures = V1ClientPort.features(undefined);

	constructor(private readonly client: AgentContext) {}

	/** What a v1 client supports, from the capabilities its `initialize` advertised. */
	static features(capabilities: ClientCapabilities | undefined): ClientFeatures {
		return {
			readTextFile: capabilities?.fs?.readTextFile === true,
			formElicitation: capabilities?.elicitation?.form != null,
			notices: capabilities?.session?.notices != null,
			compactionUpdates: capabilities?.session?.compaction != null,
			// v1 terminals are ones the client runs; shell output stays text content.
			displayTerminals: false,
		};
	}

	async terminal(): Promise<void> {
		// Never called: v1 has no display terminals.
	}

	async update(sessionId: string, update: SessionUpdate): Promise<void> {
		await this.client.notify(methods.client.session.update, { sessionId, update });
	}

	/**
	 * v1 permission requests hang off a tool call, so a dialog that opens while
	 * no tool runs gets a synthetic one to anchor it in the client's transcript.
	 */
	requestPermission(prompt: PermissionPrompt, options?: SendRequestOptions): Promise<PermissionOutcome> {
		const text = prompt.description ? `${prompt.title}\n\n${prompt.description}` : prompt.title;
		const existing = prompt.toolCall;
		const toolCallId = existing?.toolCallId ?? `pi-dialog-${prompt.dialogId}`;

		// Sent before anything is awaited, so the tool call keeps its place among
		// the updates the core sends after this call.
		const announced = existing
			? Promise.resolve()
			: this.update(prompt.sessionId, { sessionUpdate: "tool_call", toolCallId, title: text, kind: "other", status: "pending" });

		const answered = this.client
			.request(
				methods.client.session.requestPermission,
				{
					sessionId: prompt.sessionId,
					options: prompt.options,
					toolCall: {
						toolCallId,
						title: existing?.title ? `${existing.title} — ${text}` : text,
						...(existing ? {} : { kind: "other" as const }),
					},
				},
				options,
			)
			.then(
				(response): PermissionOutcome => response.outcome,
				(): PermissionOutcome => ({ outcome: "cancelled" }),
			);

		return Promise.all([announced, answered]).then(async ([, outcome]) => {
			if (!existing) {
				await this.update(prompt.sessionId, {
					sessionUpdate: "tool_call_update",
					toolCallId,
					status: outcome.outcome === "selected" ? "completed" : "failed",
				});
			}
			return outcome;
		});
	}

	elicit(request: CreateElicitationRequest, options?: SendRequestOptions): Promise<CreateElicitationResponse> {
		return this.client.request(methods.client.elicitation.create, request, options);
	}

	async readTextFile(sessionId: string, path: string): Promise<string> {
		const response = await this.client.request(methods.client.fs.readTextFile, { sessionId, path });
		return response.content;
	}

	async foreground(): Promise<void> {
		// v1 reports a turn's end by answering session/prompt, and has no way to
		// report work nobody prompted for.
	}
}
