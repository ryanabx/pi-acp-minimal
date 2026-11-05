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
	/** What the client supports, in v1 terms. */
	readonly capabilities: ClientCapabilities | undefined;
	update(sessionId: string, update: SessionUpdate): Promise<void>;
	/**
	 * Ask the user to choose an option. Anything but a selection, including a
	 * failed or withdrawn request, comes back as `cancelled`.
	 */
	requestPermission(prompt: PermissionPrompt, options?: SendRequestOptions): Promise<PermissionOutcome>;
	elicit(request: CreateElicitationRequest, options?: SendRequestOptions): Promise<CreateElicitationResponse>;
	/** A file as the client sees it; only called when `capabilities.fs.readTextFile` is set. */
	readTextFile(sessionId: string, path: string): Promise<string>;
	/**
	 * pi started or finished a run nobody prompted for: a queued follow-up, or
	 * an extension that started one. Prompted turns are reported by whoever
	 * sent the prompt.
	 */
	unpromptedRun(sessionId: string, state: ForegroundState): Promise<void>;
}

/** ACP v1: the core's messages go to the client unchanged. */
export class V1ClientPort implements ClientPort {
	constructor(
		private readonly client: AgentContext,
		/** Set once the client has sent `initialize`. */
		public capabilities: ClientCapabilities | undefined,
	) {}

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

	async unpromptedRun(): Promise<void> {
		// v1 has no way to report work nobody prompted for; its updates stand alone.
	}
}
