import type { ElicitationPropertySchema, PermissionOption, SendRequestOptions } from "@agentclientprotocol/sdk";
import type { PiExtensionUiRequest, PiExtensionUiResponse } from "../pi/rpc-types.js";
import type { ClientPort } from "./client-port.js";
import { errorMessage } from "./errors.js";
import { isPlainObject, type ToolCalls } from "./tool-calls.js";

/** What an {@link ExtensionDialogs} needs from the session it belongs to. */
export interface ExtensionDialogsSession {
	readonly sessionId: string;
	readonly port: ClientPort;
	readonly toolCalls: ToolCalls;
	/** Answer pi's dialog request. */
	respond(response: PiExtensionUiResponse): void;
	/** Tell the user something out of band; see `PiSession`'s status lines. */
	status(title: string, options?: { level?: "info" | "warning" | "error"; description?: string }): Promise<void>;
	log(message: string): void;
}

/**
 * pi extension dialogs (`ctx.ui.confirm/select/input/editor`), asked through
 * the ACP client.
 *
 * A confirmation is a permission request. A choice or free text is a form
 * elicitation when the client renders those; without one, a choice becomes a
 * permission request whose options are pi's choices, and free text is
 * declined. Every dialog is tied to the tool call running when it opened, if
 * any, and is withdrawn once pi's own dialog timeout has passed.
 */
export class ExtensionDialogs {
	constructor(private readonly session: ExtensionDialogsSession) {}

	async handle(request: PiExtensionUiRequest): Promise<void> {
		switch (request.method) {
			case "notify":
				return this.session.status(request.message, { level: request.notifyType });

			case "confirm":
				return this.#askPermission(
					request.id,
					request.title,
					request.message,
					[
						{ optionId: "yes", name: "Yes", kind: "allow_once" },
						{ optionId: "no", name: "No", kind: "reject_once" },
					],
					(optionId) => ({ type: "extension_ui_response", id: request.id, confirmed: optionId === "yes" }),
					{ type: "extension_ui_response", id: request.id, confirmed: false },
					request.timeout,
				);

			case "select":
				if (this.#supportsFormElicitation) {
					return this.#elicitText(request.id, request.title, {
						type: "string",
						oneOf: request.options.map((option) => ({ const: option, title: option })),
					}, request.timeout);
				}
				return this.#askPermission(
					request.id,
					request.title,
					undefined,
					request.options.map((option, index) => ({
						optionId: String(index),
						name: option,
						kind: permissionKindFor(option),
					})),
					(optionId) => {
						const value = request.options[Number(optionId)];
						return value === undefined
							? { type: "extension_ui_response", id: request.id, cancelled: true }
							: { type: "extension_ui_response", id: request.id, value };
					},
					{ type: "extension_ui_response", id: request.id, cancelled: true },
					request.timeout,
				);

			case "input":
				if (this.#supportsFormElicitation) {
					return this.#elicitText(request.id, request.title, {
						type: "string",
						...(request.placeholder ? { description: request.placeholder } : {}),
					}, request.timeout);
				}
				return this.#declineTextInput(request.id, request.title);

			case "editor":
				if (this.#supportsFormElicitation) {
					return this.#elicitText(request.id, request.title, {
						type: "string",
						...(request.prefill ? { default: request.prefill } : {}),
					});
				}
				return this.#declineTextInput(request.id, request.title);

			default:
				// setStatus / setWidget / setTitle / set_editor_text are TUI chrome.
				this.session.log(`ignoring extension UI request: ${request.method}`);
				return;
		}
	}

	get #supportsFormElicitation(): boolean {
		return this.session.port.features.formElicitation;
	}

	/** Ask the user for one value through a form elicitation with a single required field. */
	async #elicitText(piRequestId: string, message: string, field: ElicitationPropertySchema, timeout?: number): Promise<void> {
		const toolCallId = this.session.toolCalls.active()?.toolCallId;
		// Not awaited: pi is blocked on this dialog, and holding the event queue
		// would stall any tool output still streaming alongside it.
		void this.session.port
			.elicit(
				{
					mode: "form",
					sessionId: this.session.sessionId,
					...(toolCallId ? { toolCallId } : {}),
					message,
					requestedSchema: { type: "object", properties: { value: field }, required: ["value"] },
				},
				withTimeout(timeout),
			)
			.then(
				(response) => {
					const value = response.action === "accept" && isPlainObject(response.content) ? response.content.value : undefined;
					this.session.respond(
						typeof value === "string"
							? { type: "extension_ui_response", id: piRequestId, value }
							: { type: "extension_ui_response", id: piRequestId, cancelled: true },
					);
				},
				(error: unknown) => {
					this.session.log(`elicitation failed: ${errorMessage(error)}`);
					this.session.respond({ type: "extension_ui_response", id: piRequestId, cancelled: true });
				},
			);
	}

	/** Without elicitation there is no free-text prompt: cancel, and say why. */
	async #declineTextInput(piRequestId: string, title: string): Promise<void> {
		// Decline so the extension takes its cancellation path instead of
		// blocking pi forever.
		this.session.respond({ type: "extension_ui_response", id: piRequestId, cancelled: true });
		return this.session.status(`A pi extension asked for text input ("${title}")`, {
			level: "warning",
			description: "This client cannot show text prompts (no form elicitation), so the request was cancelled.",
		});
	}

	async #askPermission(
		requestId: string,
		title: string,
		description: string | undefined,
		options: PermissionOption[],
		toResponse: (optionId: string) => PiExtensionUiResponse,
		onCancel: PiExtensionUiResponse,
		/** pi's dialog timeout; the prompt is withdrawn once pi stops waiting. */
		timeout?: number,
	): Promise<void> {
		const toolCall = this.session.toolCalls.active();
		// Not awaited: pi is blocked on this dialog, and holding the event queue
		// would stall any tool output still streaming alongside it.
		void this.session.port
			.requestPermission(
				{
					sessionId: this.session.sessionId,
					dialogId: requestId,
					title,
					...(description ? { description } : {}),
					...(toolCall ? { toolCall } : {}),
					options,
				},
				withTimeout(timeout),
			)
			.then((outcome) => {
				this.session.respond(outcome.outcome === "selected" ? toResponse(outcome.optionId) : onCancel);
			});
	}
}

/** Guess an ACP permission kind from a pi select option's label. */
function permissionKindFor(option: string): PermissionOption["kind"] {
	const lower = option.toLowerCase();
	const rejecting = /\b(no|deny|denied|reject|block|cancel|skip|never|don't|do not)\b/.test(lower);
	const always = /\b(always|all|session|remember)\b/.test(lower);
	if (rejecting) return always ? "reject_always" : "reject_once";
	return always ? "allow_always" : "allow_once";
}

/**
 * Withdraw a client prompt (`$/cancel_request`) once pi's own dialog timeout
 * has passed: pi has already resolved the dialog by then.
 */
function withTimeout(timeout: number | undefined): SendRequestOptions | undefined {
	if (!timeout || timeout <= 0) return undefined;
	return { cancellationSignal: AbortSignal.timeout(timeout), stopWaitingOnCancel: true };
}
