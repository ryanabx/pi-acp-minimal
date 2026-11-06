import {
	type AvailableCommand,
	type ClientCapabilities,
	type ContentBlock,
	type ElicitationPropertySchema,
	type SendRequestOptions,
	type PermissionOption,
	type PromptResponse,
	type SessionConfigOption,
	type SessionNotification,
	type ToolCallContent,
	type ToolCallLocation,
	type ToolCallStatus,
	type ToolKind,
} from "@agentclientprotocol/sdk";
import { fileURLToPath } from "node:url";
import { toAcpCommand } from "../map/commands.js";
import { assistantText, contentToText, toAcpContentBlocks } from "../map/content.js";
import { buildConfigOptions } from "../map/config.js";
import { assistantPart, MessageIds } from "../map/message-ids.js";
import { fromAcpModelId, toAcpModelId } from "../map/models.js";
import type { PiMcpServerConfig } from "../map/mcp.js";
import { appendedOutput, isFileMutatingTool, isShellTool, resolvePath, toolKind, toolLocations, toolTitle } from "../map/tools.js";
import { toAcpUsageUpdate } from "../map/usage.js";
import { PiRpcClient } from "../pi/rpc-client.js";
import type {
	PiExtensionUiRequest,
	PiImageContent,
	PiMessage,
	PiModel,
	PiPromptDisposition,
	PiRpcEvent,
	PiSessionState,
	PiStopReason,
	PiThinkingLevel,
	PiToolResult,
} from "../pi/rpc-types.js";
import type { ClientPort, SessionUpdate } from "./client-port.js";
import { internalError, invalidRequest } from "./errors.js";
import { FileAccess } from "./file-access.js";

/** ACP `session/prompt` stop reasons. */
type PromptStopReason = PromptResponse["stopReason"];

export interface PiSessionOptions {
	/** Calls back into the ACP client for the lifetime of the connection. */
	client: ClientPort;
	cwd: string;
	/** Executable used to launch pi; when omitted, `pi` is located on `PATH`. */
	piCommand?: string;
	piArgs: string[];
	env?: NodeJS.ProcessEnv;
	/** Existing pi session file to resume, for `session/load`. */
	resumeSessionFile?: string;
	/** MCP servers the client supplied, in pi's format, keyed by server name. */
	mcpServers?: Record<string, PiMcpServerConfig>;
	log: (message: string) => void;
}

interface ToolCallState {
	toolName: string;
	title: string;
	kind: ToolKind;
	status: ToolCallStatus;
	args?: Record<string, unknown>;
	locations: ToolCallLocation[];
	/** File contents captured before an `edit`/`write` ran, for the ACP diff. */
	oldText?: string | null;
	filePath?: string;
	announced: boolean;
	/**
	 * Set once the call's output goes to a display terminal: the latest output
	 * snapshot already sent, which pi's cumulative updates are diffed against
	 * because the terminal appends whatever it receives.
	 */
	terminalOutput?: string;
}

/** The pi extension that registers client-supplied MCP servers; see the file for why. */
const MCP_EXTENSION = fileURLToPath(new URL("../../pi-extension/acp-mcp-servers.js", import.meta.url));

/** Session id prefix used when pi runs without session persistence. */
export const UNPERSISTED_SESSION_PREFIX = "pi-session:";

const IDLE_POLL_MS = 500;
/** Consecutive idle polls before assuming a prompt produced no agent run. */
const IDLE_OBSERVATIONS_BEFORE_SETTLE = 3;

/** pi stop reasons that end a turn without more work to do. */
const STOP_REASONS: Record<PiStopReason, PromptStopReason | undefined> = {
	stop: "end_turn",
	toolUse: "end_turn",
	length: "max_tokens",
	aborted: "cancelled",
	error: undefined,
	// Defensive: `pending` never reaches `message_end`, and a `deferred`
	// response's final content is fetched out of band, so both end the turn
	// as far as the client is concerned.
	pending: "end_turn",
	deferred: "end_turn",
};

/**
 * One ACP session backed by one `pi --mode rpc` child process.
 *
 * All pi stdout traffic is funnelled through a serial queue so that the
 * `session/update` notifications reaching the client stay in the order pi
 * produced them, even where a mapping step has to await the file system.
 */
export class PiSession {
	readonly cwd: string;
	sessionId!: string;

	#port: ClientPort;
	#client: PiRpcClient;
	#files!: FileAccess;
	#log: (message: string) => void;

	#queue: Promise<void> = Promise.resolve();
	#toolCalls = new Map<string, ToolCallState>();
	/** Most recent tool call still executing; extension dialogs attach to it. */
	#activeToolCallId: string | null = null;

	#turn: { resolve: (reason: PromptStopReason) => void; reject: (error: Error) => void } | null = null;
	#cancelled = false;
	#sawAgentRun = false;
	/** What pi reported it did with the current prompt, if anything yet. */
	#promptDisposition: PiPromptDisposition | undefined;
	#idleWatchdog: NodeJS.Timeout | null = null;
	#idleObservations = 0;
	#lastStopReason: PiStopReason | undefined;
	#lastErrorMessage: string | undefined;
	#streamedTextThisMessage = false;
	#ids = new MessageIds();
	/** Base message id of the assistant message pi is streaming. */
	#assistantMessageId: string | null = null;
	/** Reports the prompt's user message id once pi has added it to the conversation. */
	#insertion: ((messageId: string) => void) | null = null;
	/** pi is running without a prompt from the client, e.g. on a queued follow-up. */
	#unpromptedRun = false;

	#models: PiModel[] = [];
	#currentModelId: string | undefined;
	/** pi's supported levels; empty until known, or if pi cannot say. */
	#thinkingLevels: PiThinkingLevel[] = [];
	#thinkingLevel: PiThinkingLevel = "off";
	#commandSignature = "";
	#configSignature = "";
	#usageSignature = "";
	/** Compactions announced to the client so far; numbers their ids. */
	#compactions = 0;
	/** The compaction pi is running now, if the client tracks compactions. */
	#activeCompactionId: string | null = null;
	/** pi's session name; `null` once known to be unset. */
	#title: string | null = null;
	/** The title the client was last told about; `undefined` before the first update. */
	#publishedTitle: string | null | undefined;

	constructor(options: PiSessionOptions) {
		this.cwd = options.cwd;
		this.#port = options.client;
		this.#log = options.log;

		const args = [...options.piArgs];
		if (options.resumeSessionFile) args.push("--session", options.resumeSessionFile);

		let env = options.env;
		if (options.mcpServers && Object.keys(options.mcpServers).length > 0) {
			// The extension reads the servers and removes the variable before any
			// tool runs, so header and env values never reach the commands pi runs.
			args.push("-e", MCP_EXTENSION);
			env = { ...(options.env ?? process.env), PI_ACP_MCP_SERVERS: JSON.stringify(options.mcpServers) };
		}

		this.#client = new PiRpcClient({
			command: options.piCommand,
			args,
			cwd: options.cwd,
			env,
			onEvent: (event) => this.#enqueue(() => this.#handleEvent(event)),
			onExtensionUiRequest: (request) => this.#enqueue(() => this.#handleExtensionUi(request)),
			onStderr: (chunk) => this.#log(chunk.trimEnd()),
			onExit: ({ code, signal, stderr }) => {
				const error = new Error(`pi exited unexpectedly (code ${code ?? "null"}, signal ${signal ?? "null"})`);
				if (stderr) this.#log(stderr.trimEnd());
				this.#failTurn(error);
			},
		});
	}

	/** Spawn pi and read back the state the ACP client needs up front. */
	async start(): Promise<void> {
		this.#client.start();

		const state = await this.#client.request({ type: "get_state" });
		// The session file doubles as the ACP session id so `session/load` can resume it.
		this.sessionId = state.sessionFile ?? `${UNPERSISTED_SESSION_PREFIX}${state.sessionId}`;
		this.#files = new FileAccess(this.#port, () => this.sessionId);

		this.#title = state.sessionName ?? null;
		await this.refreshModelState(state);
		await this.refreshThinkingState(state);
		// Seed the signature: session/new carries these options in its response.
		this.#configSignature = JSON.stringify(this.configOptions());
	}

	async stop(): Promise<void> {
		await this.#client.stop();
	}

	/**
	 * Cancel any running turn, then stop pi.
	 *
	 * Once pi is gone no `agent_settled` can arrive, so a turn still waiting on
	 * one ends here as cancelled rather than hanging its `session/prompt`.
	 */
	async close(): Promise<void> {
		await this.cancel();
		await this.stop();
		this.#stopIdleWatchdog();
		const turn = this.#turn;
		this.#turn = null;
		this.#insertion = null;
		turn?.resolve("cancelled");
	}

	/**
	 * Keep the client's session id authoritative after `session/load`.
	 *
	 * pi may resolve `--session <path>` to a slightly different file; the client
	 * only knows the id it asked for, so notifications must keep using it.
	 */
	adoptSessionId(sessionId: string): void {
		this.sessionId = sessionId;
	}

	// ==========================================================================
	// Model / mode state
	// ==========================================================================

	async refreshModelState(state?: PiSessionState): Promise<void> {
		const [{ models }, current] = await Promise.all([
			this.#client.request({ type: "get_available_models" }),
			state ? Promise.resolve(state) : this.#client.request({ type: "get_state" }),
		]);
		this.#models = models;
		this.#currentModelId = current.model ? toAcpModelId(current.model) : undefined;
	}

	async refreshThinkingState(state?: PiSessionState): Promise<void> {
		// A failed query is treated the same as pi offering no choice: no control.
		const levelsPromise = this.#client.request({ type: "get_available_thinking_levels" }).then(
			({ levels }) => levels,
			(error: unknown) => {
				this.#log(`could not read thinking levels: ${errorMessage(error)}`);
				return [] as PiThinkingLevel[];
			},
		);
		const [levels, current] = await Promise.all([
			levelsPromise,
			state ? Promise.resolve(state) : this.#client.request({ type: "get_state" }),
		]);
		this.#thinkingLevels = levels;
		this.#thinkingLevel = current.thinkingLevel;
	}

	get availableThinkingLevels(): PiThinkingLevel[] {
		return this.#thinkingLevels;
	}

	/**
	 * Report how full the context window is, if pi can say.
	 *
	 * Skipped silently when pi has no figure to give: a session with no model, or
	 * the gap just after compaction before a fresh assistant response lands.
	 */
	async publishUsage(): Promise<void> {
		let update: ReturnType<typeof toAcpUsageUpdate>;
		try {
			update = toAcpUsageUpdate(await this.#client.request({ type: "get_session_stats" }));
		} catch (error) {
			this.#log(`failed to read session stats: ${errorMessage(error)}`);
			return;
		}
		if (!update) return;

		const signature = JSON.stringify(update);
		if (signature === this.#usageSignature) return;
		this.#usageSignature = signature;
		await this.#notify({ sessionUpdate: "usage_update", ...update });
	}

	/**
	 * Re-read pi's model and thinking state and push an update if it moved.
	 *
	 * pi's view of a model can change while a session runs: an extension command
	 * such as `/llama` can add or remove models, and llama.cpp only reports a
	 * model's real fitted context window once it has been loaded, so the numbers
	 * shown at session start are not necessarily the final ones.
	 */
	async publishConfigOptions(): Promise<void> {
		try {
			await this.refreshModelState();
			await this.refreshThinkingState();
		} catch (error) {
			this.#log(`failed to refresh config options: ${errorMessage(error)}`);
			return;
		}

		const options = this.configOptions();
		const signature = JSON.stringify(options);
		if (signature === this.#configSignature) return;
		this.#configSignature = signature;
		await this.#notify({ sessionUpdate: "config_option_update", configOptions: options });
	}

	/**
	 * Config options for a response that itself carries them to the client.
	 *
	 * Records the signature so the next `publishConfigOptions` does not re-announce
	 * state the client has already been told about.
	 */
	acknowledgeConfigOptions(): SessionConfigOption[] {
		const options = this.configOptions();
		this.#configSignature = JSON.stringify(options);
		return options;
	}

	/** pi's model and thinking-level state as ACP session config options. */
	configOptions(): SessionConfigOption[] {
		return buildConfigOptions({
			models: this.#models,
			currentModelId: this.#currentModelId,
			thinkingLevels: this.#thinkingLevels,
			thinkingLevel: this.#thinkingLevel,
		});
	}

	async setModel(acpModelId: string): Promise<void> {
		const { provider, modelId } = fromAcpModelId(acpModelId);
		const model = await this.#client.request({ type: "set_model", provider, modelId });
		this.#currentModelId = toAcpModelId(model);
		// Reasoning support is per-model, so the thinking levels may have changed too.
		await this.refreshThinkingState();
	}

	/**
	 * Ask pi to change the thinking level, then read back what it actually did.
	 *
	 * pi clamps the requested level to what the current model supports and
	 * reports success either way, so the response cannot be taken at face value:
	 * on a model without reasoning support every level clamps to "off".
	 */
	async setThinkingLevel(level: PiThinkingLevel): Promise<PiThinkingLevel> {
		await this.#client.request({ type: "set_thinking_level", level });
		await this.refreshThinkingState();
		return this.#thinkingLevel;
	}

	// ==========================================================================
	// Slash commands
	// ==========================================================================

	/**
	 * Publish the title, commands and usage once the caller's own response has been sent.
	 *
	 * Used by `session/new`, where notifying before the response would reference a
	 * session the client has not registered yet. The SDK queues a response for
	 * writing only after the handler's promise settles, several microtasks later,
	 * so a microtask is too early; the next macrotask runs after the response is
	 * queued, and the SDK writes frames in the order they were queued.
	 */
	publishSessionStateSoon(): void {
		setImmediate(() => {
			void (async () => {
				await this.publishSessionInfo();
				await this.publishCommands();
				await this.publishUsage();
			})().catch((error: unknown) => {
				this.#log(`failed to publish initial session state: ${errorMessage(error)}`);
			});
		});
	}

	/**
	 * Tell the client pi's session name, as the ACP session title.
	 *
	 * Sent once a session has a name (an unnamed new session stays quiet) and
	 * again whenever it changes, including back to unnamed.
	 */
	async publishSessionInfo(): Promise<void> {
		if (this.#title === this.#publishedTitle) return;
		if (this.#publishedTitle === undefined && this.#title === null) return;
		this.#publishedTitle = this.#title;
		await this.#notify({ sessionUpdate: "session_info_update", title: this.#title });
	}

	/** Push pi's slash commands to the client, skipping unchanged lists. */
	async publishCommands(): Promise<void> {
		let commands: AvailableCommand[];
		try {
			const { commands: piCommands } = await this.#client.request({ type: "get_commands" });
			commands = piCommands.map(toAcpCommand);
		} catch (error) {
			this.#log(`failed to load pi commands: ${errorMessage(error)}`);
			return;
		}

		const signature = JSON.stringify(commands);
		if (signature === this.#commandSignature) return;
		this.#commandSignature = signature;
		await this.#notify({ sessionUpdate: "available_commands_update", availableCommands: commands });
	}

	// ==========================================================================
	// Prompt turn
	// ==========================================================================

	/**
	 * Run one prompt turn, resolving with its stop reason once pi has settled.
	 *
	 * `onInserted` is called with the id of the prompt's user message as soon as
	 * pi has added it to the conversation, before the turn ends; ACP v2 answers
	 * `session/prompt` at that point. It is not called when the prompt fails or
	 * is cancelled before pi takes it.
	 */
	async prompt(
		message: string,
		images: PiImageContent[],
		{ onInserted }: { onInserted?: (messageId: string) => void } = {},
	): Promise<PromptStopReason> {
		if (this.#turn) throw invalidRequest("A prompt turn is already in progress for this session");

		this.#cancelled = false;
		this.#sawAgentRun = false;
		this.#promptDisposition = undefined;
		this.#lastStopReason = undefined;
		this.#lastErrorMessage = undefined;
		this.#toolCalls.clear();
		this.#activeToolCallId = null;

		const settled = new Promise<PromptStopReason>((resolve, reject) => {
			this.#turn = { resolve, reject };
		});
		this.#insertion = onInserted ?? null;

		try {
			const response = await this.#client.request({
				type: "prompt",
				message,
				images: images.length > 0 ? images : undefined,
			});
			// Older pi builds send no `data` on the prompt response.
			this.#promptDisposition = response?.disposition;
		} catch (error) {
			this.#turn = null;
			this.#insertion = null;
			throw internalError(errorMessage(error));
		}
		// pi stores no user message for a prompt an extension command handled,
		// and stores a queued one only once it gets to it.
		if (this.#promptDisposition === "handled" || this.#promptDisposition === "queued") {
			this.#markInserted(this.#ids.unstoredPrompt());
		}

		if (this.#promptDisposition === "handled" && !this.#sawAgentRun) {
			// An extension command or input handler consumed the prompt: pi will
			// not start a run for it, so there is no agent_settled to wait for.
			// Queue behind events pi already sent so their updates land first.
			this.#log('pi reported the prompt "handled" without an agent run; ending turn');
			this.#enqueue(() => this.#settleTurn());
		} else {
			// "started" and "queued" end on agent_settled. The watchdog covers pi
			// builds that do not report a disposition.
			this.#startIdleWatchdog();
		}
		const stopReason = await settled;
		await this.publishCommands();
		await this.publishConfigOptions();
		await this.publishUsage();
		return stopReason;
	}

	async cancel(): Promise<void> {
		if (!this.#turn && !this.#unpromptedRun) return;
		if (this.#turn) this.#cancelled = true;
		try {
			await this.#client.request({ type: "abort" });
		} catch (error) {
			this.#log(`abort failed: ${errorMessage(error)}`);
		}
	}

	// ==========================================================================
	// Replay (session/load)
	// ==========================================================================

	/** Re-emit the stored conversation as `session/update` notifications. */
	async replayHistory(): Promise<void> {
		const { messages } = await this.#client.request({ type: "get_messages" });
		for (const message of messages) {
			await this.#replayMessage(message);
		}
	}

	async #replayMessage(message: PiMessage): Promise<void> {
		switch (message.role) {
			case "user": {
				const messageId = this.#ids.user(message);
				for (const content of toAcpContentBlocks(message.content)) {
					await this.#notify({ sessionUpdate: "user_message_chunk", messageId, content });
				}
				return;
			}
			case "assistant": {
				const base = this.#ids.assistant(message);
				for (const [index, part] of message.content.entries()) {
					if (part.type === "text") {
						if (part.text) {
							await this.#notify({
								sessionUpdate: "agent_message_chunk",
								messageId: assistantPart(base, index),
								content: { type: "text", text: part.text },
							});
						}
					} else if (part.type === "thinking") {
						if (part.thinking) {
							await this.#notify({
								sessionUpdate: "agent_thought_chunk",
								messageId: assistantPart(base, index),
								content: { type: "text", text: part.thinking },
							});
						}
					} else {
						const args = part.arguments ?? {};
						// Left in_progress: the matching toolResult message completes it,
						// and an interrupted session honestly has none.
						const state: ToolCallState = {
							toolName: part.name,
							title: toolTitle(this.cwd, part.name, args),
							kind: toolKind(part.name),
							status: "in_progress",
							args,
							locations: toolLocations(this.cwd, part.name, args),
							announced: true,
						};
						this.#toolCalls.set(part.id, state);
						await this.#notify({
							sessionUpdate: "tool_call",
							toolCallId: part.id,
							title: state.title,
							kind: state.kind,
							status: state.status,
							rawInput: args,
							locations: state.locations,
						});
					}
				}
				if (message.stopReason === "error" && message.errorMessage) {
					await this.#notify({
						sessionUpdate: "agent_message_chunk",
						messageId: assistantPart(base, "error"),
						content: { type: "text", text: `\n_pi error: ${message.errorMessage}_\n` },
					});
				}
				return;
			}
			case "toolResult": {
				const state = this.#toolCalls.get(message.toolCallId);
				if (state && isShellTool(message.toolName) && this.#showsTerminals) {
					await this.#openTerminal(message.toolCallId, state);
					return this.#closeTerminal(message.toolCallId, state, message, message.isError === true);
				}
				await this.#notify({
					sessionUpdate: "tool_call_update",
					toolCallId: message.toolCallId,
					status: message.isError ? "failed" : "completed",
					content: toolResultContent({ content: message.content }),
				});
				return;
			}
			case "bashExecution": {
				const text = ["Ran `" + message.command + "`", "```", message.output, "```"].join("\n");
				await this.#notify({
					sessionUpdate: "user_message_chunk",
					messageId: this.#ids.bashExecution(message),
					content: { type: "text", text },
				});
				return;
			}

			case "custom": {
				// Extension context message. pi shows these only when `display` is
				// true and converts them to a user message for the model.
				if (!message.display) return;
				const messageId = this.#ids.custom(message);
				for (const content of toAcpContentBlocks(message.content)) {
					await this.#notify({ sessionUpdate: "user_message_chunk", messageId, content });
				}
				return;
			}

			case "compactionSummary":
				// A client that tracks compactions shows where one happened; for
				// anyone else the summary is model context, not transcript.
				if (!this.#tracksCompactions) return;
				return this.#notify({
					sessionUpdate: "compaction_update",
					compactionId: this.#nextCompactionId(),
					status: "completed",
					summary: [{ type: "text", text: message.summary }],
				});

			default:
				// system and branchSummary are model context, not transcript: pi
				// sends them in get_messages but they are not part of the
				// conversation a client wants reloaded.
				return;
		}
	}

	// ==========================================================================
	// Event mapping
	// ==========================================================================

	#enqueue(work: () => Promise<void>): void {
		this.#queue = this.#queue
			.then(work)
			.catch((error: unknown) => this.#log(`event handling failed: ${errorMessage(error)}`));
	}

	async #handleEvent(event: PiRpcEvent): Promise<void> {
		switch (event.type) {
			case "agent_start":
				if (!this.#turn) {
					// Nobody prompted for this run: a queued follow-up, or an extension
					// that started one.
					this.#unpromptedRun = true;
					this.#lastStopReason = undefined;
					this.#lastErrorMessage = undefined;
					return this.#port.unpromptedRun(this.sessionId, { state: "running" });
				}
				// A real agent run is under way; the turn now ends on `agent_settled`.
				this.#sawAgentRun = true;
				this.#stopIdleWatchdog();
				return;

			case "message_start":
				if (event.message.role === "user") {
					this.#markInserted(this.#ids.user(event.message));
				} else if (event.message.role === "assistant") {
					// pi answering without a user message of its own means it stored none.
					this.#markInserted(this.#ids.unstoredPrompt());
					this.#streamedTextThisMessage = false;
					this.#assistantMessageId = this.#ids.assistant(event.message);
				}
				return;

			case "message_update":
				return this.#handleMessageUpdate(event.assistantMessageEvent);

			case "message_end":
				return this.#handleMessageEnd(event.message);

			case "tool_execution_start":
				return this.#handleToolStart(event.toolCallId, event.toolName, event.args, event.parentToolCallId);

			case "tool_execution_update":
				return this.#handleToolUpdate(event.toolCallId, event.partialResult);

			case "tool_execution_end":
				return this.#handleToolEnd(event.toolCallId, event.result, event.isError);

			case "turn_end":
				// Progressive reporting: a long agentic run fills the context well
				// before the prompt turn as a whole finishes.
				return this.publishUsage();

			case "agent_settled":
				if (this.#unpromptedRun) await this.#settleUnpromptedRun(event.aborted === true);
				return this.#settleTurn(event.aborted === true);

			case "compaction_start":
				if (this.#tracksCompactions) {
					this.#activeCompactionId = this.#nextCompactionId();
					return this.#notify({
						sessionUpdate: "compaction_update",
						compactionId: this.#activeCompactionId,
						status: "in_progress",
					});
				}
				return this.#status(`Compacting context (${event.reason})…`);

			case "compaction_end": {
				if (this.#tracksCompactions) return this.#endCompaction(event);
				if (event.aborted) return this.#status("Compaction aborted.");
				if (!event.result) {
					return this.#status("Compaction failed", { level: "error", description: event.errorMessage ?? "unknown error" });
				}
				const before = event.result.tokensBefore;
				const after = event.result.estimatedTokensAfter;
				const detail = before && after ? ` (~${before} → ~${after} tokens)` : "";
				return this.#status(`Context compacted${detail}.`);
			}

			case "thinking_level_changed":
				// pi's level can move without a prompt from us (an extension or a
				// model switch can change it); re-read pi's state and let the client
				// know now instead of at the next turn's end.
				return this.publishConfigOptions();

			case "auto_retry_start":
				return this.#status(
					`Retrying after error (attempt ${event.attempt}/${event.maxAttempts}, waiting ${Math.round(event.delayMs / 1000)}s)`,
					{ level: "warning", description: event.errorMessage },
				);

			case "auto_retry_end":
				if (event.success) return this.#status(`Retry succeeded on attempt ${event.attempt}.`);
				return this.#status(`Retries exhausted after ${event.attempt} attempts`, {
					level: "error",
					description: event.finalError ?? "unknown error",
				});

			case "summarization_retry_scheduled":
				return this.#status(`Retrying summarization (attempt ${event.attempt}/${event.maxAttempts})`, {
					level: "warning",
					description: event.errorMessage,
				});

			case "session_info_changed":
				// /name, --name, or an extension's pi.setSessionName(); absent clears it.
				this.#title = event.name?.trim() || null;
				return this.publishSessionInfo();

			case "extension_error":
				this.#log(`extension error in ${event.extensionPath} (${event.event}): ${event.error}`);
				return this.#status(`Extension error (${event.event})`, { level: "error", description: event.error });

			default:
				// agent_end, turn_start, queue_update and the remaining retry events
				// carry no information the client needs.
				return;
		}
	}

	async #handleMessageUpdate(event: AssistantMessageDelta): Promise<void> {
		switch (event.type) {
			case "text_delta":
				if (!event.delta) return;
				this.#streamedTextThisMessage = true;
				return this.#notify({
					sessionUpdate: "agent_message_chunk",
					messageId: this.#assistantPartId(event.contentIndex),
					content: { type: "text", text: event.delta },
				});

			case "thinking_delta":
				if (!event.delta) return;
				return this.#notify({
					sessionUpdate: "agent_thought_chunk",
					messageId: this.#assistantPartId(event.contentIndex),
					content: { type: "text", text: event.delta },
				});

			case "toolcall_start": {
				// Arguments have not streamed in yet; announce the call so the client can
				// show it immediately, then refine the title once they arrive.
				const state: ToolCallState = {
					toolName: event.toolName,
					title: toolTitle(this.cwd, event.toolName),
					kind: toolKind(event.toolName),
					status: "pending",
					locations: [],
					announced: true,
				};
				this.#toolCalls.set(event.id, state);
				return this.#notify({
					sessionUpdate: "tool_call",
					toolCallId: event.id,
					title: state.title,
					kind: state.kind,
					status: "pending",
				});
			}

			case "toolcall_end": {
				const args = event.toolCall.arguments ?? {};
				return this.#describeToolCall(event.toolCall.id, event.toolCall.name, args, null);
			}

			default:
				return;
		}
	}

	async #handleMessageEnd(message: PiMessage): Promise<void> {
		if (message.role !== "assistant") return;

		this.#lastStopReason = message.stopReason;
		this.#lastErrorMessage = message.errorMessage;

		// Providers that do not stream text deltas still deliver the full message here.
		if (!this.#streamedTextThisMessage) {
			const text = assistantText(message);
			if (text) {
				const base = this.#assistantMessageId ?? this.#ids.assistant(message);
				const index = message.content.findIndex((part) => part.type === "text");
				await this.#notify({
					sessionUpdate: "agent_message_chunk",
					messageId: assistantPart(base, index),
					content: { type: "text", text },
				});
			}
		}
		this.#streamedTextThisMessage = false;
		this.#assistantMessageId = null;
	}

	/** The message id of one content part of the assistant message pi is streaming. */
	#assistantPartId(contentIndex: number): string {
		this.#assistantMessageId ??= this.#ids.assistant({});
		return assistantPart(this.#assistantMessageId, contentIndex);
	}

	/** Report the prompt's user message as added to the conversation, once. */
	#markInserted(messageId: string): void {
		const insertion = this.#insertion;
		this.#insertion = null;
		insertion?.(messageId);
	}

	/** Fill in everything derivable from a tool call's complete arguments. */
	async #describeToolCall(
		toolCallId: string,
		toolName: string,
		args: Record<string, unknown>,
		status: ToolCallStatus | null,
	): Promise<void> {
		const state = this.#toolCalls.get(toolCallId) ?? {
			toolName,
			title: toolTitle(this.cwd, toolName, args),
			kind: toolKind(toolName),
			status: "pending" as ToolCallStatus,
			locations: [],
			announced: false,
		};

		state.args = args;
		state.title = toolTitle(this.cwd, toolName, args);
		state.kind = toolKind(toolName);
		state.locations = toolLocations(this.cwd, toolName, args);
		if (status) state.status = status;
		this.#toolCalls.set(toolCallId, state);

		if (!state.announced) {
			state.announced = true;
			return this.#notify({
				sessionUpdate: "tool_call",
				toolCallId,
				title: state.title,
				kind: state.kind,
				status: state.status,
				rawInput: args,
				locations: state.locations,
			});
		}

		return this.#notify({
			sessionUpdate: "tool_call_update",
			toolCallId,
			title: state.title,
			kind: state.kind,
			status: state.status,
			rawInput: args,
			locations: state.locations,
		});
	}

	async #handleToolStart(
		toolCallId: string,
		toolName: string,
		args: Record<string, unknown>,
		parentToolCallId: string | undefined,
	): Promise<void> {
		// A call a tool makes through `ctx.executeTool()` still shows as its own
		// tool call, but the calling tool stays the one a dialog belongs to:
		// otherwise the nested call's end would leave no active tool call behind.
		if (!parentToolCallId) this.#activeToolCallId = toolCallId;
		await this.#describeToolCall(toolCallId, toolName, args, "in_progress");

		const started = this.#toolCalls.get(toolCallId);
		if (started && isShellTool(toolName) && this.#showsTerminals) await this.#openTerminal(toolCallId, started);

		// Snapshot the file before it changes so the completion can carry a real diff.
		if (isFileMutatingTool(toolName)) {
			const state = this.#toolCalls.get(toolCallId);
			const rawPath = typeof args.path === "string" ? args.path : undefined;
			if (state && rawPath) {
				state.filePath = resolvePath(this.cwd, rawPath);
				state.oldText = await this.#files.readText(state.filePath);
			}
		}
	}

	async #handleToolUpdate(toolCallId: string, partialResult: PiToolResult | undefined): Promise<void> {
		const state = this.#toolCalls.get(toolCallId);
		if (state?.terminalOutput !== undefined) {
			return this.#writeTerminal(toolCallId, state, contentToText(partialResult?.content));
		}
		const content = toolResultContent(partialResult);
		if (content.length === 0) return;
		return this.#notify({ sessionUpdate: "tool_call_update", toolCallId, status: "in_progress", content });
	}

	async #handleToolEnd(toolCallId: string, result: PiToolResult | undefined, isError: boolean): Promise<void> {
		if (this.#activeToolCallId === toolCallId) this.#activeToolCallId = null;

		const state = this.#toolCalls.get(toolCallId);
		if (state) state.status = isError ? "failed" : "completed";
		if (state?.terminalOutput !== undefined) return this.#closeTerminal(toolCallId, state, result, isError);

		const content: ToolCallContent[] = [];
		if (state && !isError && isFileMutatingTool(state.toolName) && state.filePath) {
			const newText = await this.#files.readText(state.filePath);
			if (newText !== null) {
				content.push({ type: "diff", path: state.filePath, oldText: state.oldText ?? null, newText });
			}
		}
		if (content.length === 0) content.push(...toolResultContent(result));

		const details = result?.details;
		await this.#notify({
			sessionUpdate: "tool_call_update",
			toolCallId,
			status: isError ? "failed" : "completed",
			content,
			...(isPlainObject(details) ? { rawOutput: details } : {}),
		});
	}

	// ==========================================================================
	// Display terminals
	// ==========================================================================
	//
	// A client whose port displays terminals (ACP v2) shows a shell command's
	// output in a terminal it only displays, named after the tool call; the
	// tool call refers to it instead of carrying the output as text.

	get #showsTerminals(): boolean {
		return this.#port.displaysTerminals;
	}

	async #openTerminal(toolCallId: string, state: ToolCallState): Promise<void> {
		if (state.terminalOutput !== undefined) return;
		state.terminalOutput = "";
		const command = typeof state.args?.command === "string" ? state.args.command : undefined;
		// The terminal exists before the tool call refers to it.
		await this.#port.terminal(this.sessionId, {
			type: "open",
			terminalId: toolCallId,
			cwd: this.cwd,
			...(command ? { command } : {}),
		});
		await this.#notify({
			sessionUpdate: "tool_call_update",
			toolCallId,
			content: [{ type: "terminal", terminalId: toolCallId }],
		});
	}

	async #writeTerminal(toolCallId: string, state: ToolCallState, snapshot: string): Promise<void> {
		const data = appendedOutput(state.terminalOutput ?? "", snapshot);
		state.terminalOutput = snapshot;
		if (!data) return;
		await this.#port.terminal(this.sessionId, { type: "output", terminalId: toolCallId, data });
	}

	async #closeTerminal(
		toolCallId: string,
		state: ToolCallState,
		result: PiToolResult | undefined,
		isError: boolean,
	): Promise<void> {
		// The final text adds pi's status lines ("Command exited with code 2",
		// truncation notes) after the output already streamed.
		await this.#writeTerminal(toolCallId, state, contentToText(result?.content));
		const structured = result?.structuredContent;
		const reported = isPlainObject(structured) ? structured.exit_code : undefined;
		const exitCode = typeof reported === "number" ? reported : isError ? null : 0;
		await this.#port.terminal(this.sessionId, { type: "exit", terminalId: toolCallId, exitCode });
		const details = result?.details;
		await this.#notify({
			sessionUpdate: "tool_call_update",
			toolCallId,
			status: isError ? "failed" : "completed",
			content: [{ type: "terminal", terminalId: toolCallId }],
			...(isPlainObject(details) ? { rawOutput: details } : {}),
		});
	}

	/**
	 * Guard against prompts that never start an agent run.
	 *
	 * Extension commands (`/mycommand`) are handled inline by pi and may finish
	 * without emitting `agent_start`/`agent_settled`, which would leave
	 * `session/prompt` pending forever. pi reports these as a `"handled"`
	 * disposition, which ends the turn directly; this is the fallback for pi
	 * builds that report no disposition and for a reported run that never
	 * materialises. Poll pi until it has been idle for a few consecutive
	 * checks, then end the turn ourselves.
	 */
	#startIdleWatchdog(): void {
		this.#stopIdleWatchdog();
		this.#idleObservations = 0;
		this.#idleWatchdog = setInterval(() => void this.#pollForIdle(), IDLE_POLL_MS);
		this.#idleWatchdog.unref?.();
	}

	#stopIdleWatchdog(): void {
		if (!this.#idleWatchdog) return;
		clearInterval(this.#idleWatchdog);
		this.#idleWatchdog = null;
	}

	async #pollForIdle(): Promise<void> {
		if (!this.#turn || this.#sawAgentRun) return this.#stopIdleWatchdog();

		let state: PiSessionState;
		try {
			state = await this.#client.request({ type: "get_state" });
		} catch {
			return;
		}
		if (!this.#turn || this.#sawAgentRun) return this.#stopIdleWatchdog();

		if (state.isStreaming || state.isCompacting || state.pendingMessageCount > 0) {
			this.#idleObservations = 0;
			return;
		}
		if (++this.#idleObservations < IDLE_OBSERVATIONS_BEFORE_SETTLE) return;

		this.#stopIdleWatchdog();
		this.#log(
			`prompt completed without an agent run (pi reported "${this.#promptDisposition ?? "unknown"}"); ending turn`,
		);
		this.#enqueue(() => this.#settleTurn());
	}

	async #settleTurn(aborted = false): Promise<void> {
		this.#stopIdleWatchdog();
		const turn = this.#turn;
		if (!turn) return;
		this.#turn = null;
		// pi took the prompt (it answered it) but stored no user message for it.
		this.#markInserted(this.#ids.unstoredPrompt());

		// pi reports an aborted run on agent_settled; that is authoritative where
		// the last assistant stop reason is not, for example an abort while a tool
		// was still running, which leaves the previous "toolUse" reason behind.
		if (this.#cancelled || aborted) return turn.resolve("cancelled");

		const stopReason = this.#lastStopReason;
		if (stopReason === "error") {
			return turn.reject(internalError(this.#lastErrorMessage ?? "pi turn failed"));
		}
		turn.resolve((stopReason && STOP_REASONS[stopReason]) ?? "end_turn");
	}

	#failTurn(error: Error): void {
		this.#stopIdleWatchdog();
		const turn = this.#turn;
		if (!turn) return;
		this.#turn = null;
		this.#insertion = null;
		turn.reject(error);
	}

	async #settleUnpromptedRun(aborted: boolean): Promise<void> {
		this.#unpromptedRun = false;
		const stopReason = this.#lastStopReason;
		if (!aborted && stopReason === "error") {
			return this.#port.unpromptedRun(this.sessionId, {
				state: "idle",
				stopReason: "error",
				error: { code: -32603, message: this.#lastErrorMessage ?? "pi run failed" },
			});
		}
		return this.#port.unpromptedRun(this.sessionId, {
			state: "idle",
			stopReason: aborted ? "cancelled" : ((stopReason && STOP_REASONS[stopReason]) ?? "end_turn"),
		});
	}

	// ==========================================================================
	// Extension UI bridge
	// ==========================================================================

	async #handleExtensionUi(request: PiExtensionUiRequest): Promise<void> {
		switch (request.method) {
			case "notify":
				return this.#status(request.message, { level: request.notifyType });

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
				// Without elicitation, a choice is rendered as a permission prompt
				// whose options are pi's choices.
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
				this.#log(`ignoring extension UI request: ${request.method}`);
				return;
		}
	}

	/** Whether the client renders form elicitations (`elicitation.form`). */
	get #supportsFormElicitation(): boolean {
		return this.#clientCapabilities?.elicitation?.form != null;
	}

	/**
	 * Ask the user for one value through an ACP form elicitation, and hand it to pi.
	 *
	 * The form has a single required field. It is tied to the running tool
	 * call, if any, like the permission prompts. When pi gives the dialog a
	 * timeout, the elicitation is withdrawn once pi has stopped waiting.
	 */
	async #elicitText(piRequestId: string, message: string, field: ElicitationPropertySchema, timeout?: number): Promise<void> {
		const toolCallId = this.#activeToolCallId;
		// Not awaited: pi is blocked on this dialog, and holding the event queue
		// would stall any tool output still streaming alongside it.
		void this.#port
			.elicit(
				{
					mode: "form",
					sessionId: this.sessionId,
					...(toolCallId ? { toolCallId } : {}),
					message,
					requestedSchema: { type: "object", properties: { value: field }, required: ["value"] },
				},
				withTimeout(timeout),
			)
			.then(
				(response) => {
					const value = response.action === "accept" && isPlainObject(response.content) ? response.content.value : undefined;
					this.#client.respondExtensionUi(
						typeof value === "string"
							? { type: "extension_ui_response", id: piRequestId, value }
							: { type: "extension_ui_response", id: piRequestId, cancelled: true },
					);
				},
				(error: unknown) => {
					this.#log(`elicitation failed: ${errorMessage(error)}`);
					this.#client.respondExtensionUi({ type: "extension_ui_response", id: piRequestId, cancelled: true });
				},
			);
	}

	/** Without elicitation there is no free-text prompt: cancel, and say why. */
	async #declineTextInput(piRequestId: string, title: string): Promise<void> {
		// Decline so the extension takes its cancellation path instead of
		// blocking pi forever.
		this.#client.respondExtensionUi({ type: "extension_ui_response", id: piRequestId, cancelled: true });
		return this.#status(`A pi extension asked for text input ("${title}")`, {
			level: "warning",
			description: "This client cannot show text prompts (no form elicitation), so the request was cancelled.",
		});
	}

	/** Render a pi extension dialog as an ACP permission request, tied to the running tool call if any. */
	async #askPermission(
		requestId: string,
		title: string,
		description: string | undefined,
		options: PermissionOption[],
		toResponse: (optionId: string) => Parameters<PiRpcClient["respondExtensionUi"]>[0],
		onCancel: Parameters<PiRpcClient["respondExtensionUi"]>[0],
		/** pi's dialog timeout; the prompt is withdrawn once pi stops waiting. */
		timeout?: number,
	): Promise<void> {
		const toolCallId = this.#activeToolCallId;
		const toolTitle = toolCallId ? this.#toolCalls.get(toolCallId)?.title : undefined;

		// Not awaited: pi is blocked on this dialog, and holding the event queue
		// would stall any tool output still streaming alongside it.
		void this.#port
			.requestPermission(
				{
					sessionId: this.sessionId,
					dialogId: requestId,
					title,
					...(description ? { description } : {}),
					...(toolCallId ? { toolCall: { toolCallId, ...(toolTitle ? { title: toolTitle } : {}) } } : {}),
					options,
				},
				withTimeout(timeout),
			)
			.then((outcome) => {
				this.#client.respondExtensionUi(outcome.outcome === "selected" ? toResponse(outcome.optionId) : onCancel);
			});
	}

	// ==========================================================================
	// Notification helpers
	// ==========================================================================

	get #clientCapabilities(): ClientCapabilities | undefined {
		return this.#port.capabilities;
	}

	/** Whether the client advertised `session.compaction`, which compaction updates require. */
	get #tracksCompactions(): boolean {
		return Boolean(this.#clientCapabilities?.session?.compaction);
	}

	#nextCompactionId(): string {
		return `pi-compaction-${++this.#compactions}`;
	}

	/** Finish the compaction entity opened on `compaction_start`. */
	async #endCompaction(event: Extract<PiRpcEvent, { type: "compaction_end" }>): Promise<void> {
		// An end without a start we saw still gets an entity of its own.
		const compactionId = this.#activeCompactionId ?? this.#nextCompactionId();
		this.#activeCompactionId = null;
		if (event.aborted) {
			return this.#notify({ sessionUpdate: "compaction_update", compactionId, status: "cancelled" });
		}
		if (!event.result) {
			return this.#notify({
				sessionUpdate: "compaction_update",
				compactionId,
				status: "failed",
				error: event.errorMessage ?? "unknown error",
			});
		}
		return this.#notify({
			sessionUpdate: "compaction_update",
			compactionId,
			status: "completed",
			summary: [{ type: "text", text: event.result.summary }],
		});
	}

	/**
	 * Out-of-band information for the user: retries, extension messages and the like.
	 *
	 * Sent as an ACP `notice` when the client advertises `session.notices`;
	 * otherwise as an italic agent message line, which is the fallback the
	 * protocol suggests. A multi-line title keeps its first line as the title
	 * and moves the rest into the description.
	 */
	async #status(
		title: string,
		{ level = "info", description }: { level?: "info" | "warning" | "error"; description?: string } = {},
	): Promise<void> {
		const [first = "", ...rest] = title.trim().split(/\n+/);
		const detail = [rest.join(" ").trim(), description?.trim()].filter(Boolean).join(" ") || undefined;
		const heading = first.trim() || detail;
		if (!heading) return;

		if (this.#clientCapabilities?.session?.notices) {
			await this.#notify({
				sessionUpdate: "notice",
				severity: level,
				title: heading,
				...(detail && heading !== detail ? { description: detail } : {}),
			});
			return;
		}

		const prefix = level === "info" ? "" : "⚠ ";
		const text = detail && heading !== detail ? `${heading}: ${detail}` : heading;
		await this.#notify({
			sessionUpdate: "agent_message_chunk",
			messageId: this.#ids.adapterNote(),
			content: { type: "text", text: `\n_${prefix}${text.replace(/\n+/g, " ")}_\n` },
		});
	}

	async #notify(update: SessionUpdate): Promise<void> {
		await this.#port.update(this.sessionId, update);
	}
}

type AssistantMessageDelta = Extract<PiRpcEvent, { type: "message_update" }>["assistantMessageEvent"];

/** pi tool output -> ACP tool call content blocks. */
function toolResultContent(result: PiToolResult | undefined): ToolCallContent[] {
	if (!result) return [];
	const blocks: ContentBlock[] = toAcpContentBlocks(result.content);
	return blocks.map((content) => ({ type: "content", content }));
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
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

export function errorMessage(error: unknown): string {
	if (error instanceof Error) return error.message;
	return String(error);
}


