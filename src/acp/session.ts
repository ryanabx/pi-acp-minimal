import type { AvailableCommand, PromptResponse, SessionConfigOption } from "@agentclientprotocol/sdk";
import { fileURLToPath } from "node:url";
import { toAcpCommand } from "../map/commands.js";
import { assistantText } from "../map/content.js";
import { buildConfigOptions } from "../map/config.js";
import { assistantPart, MessageIds } from "../map/message-ids.js";
import { fromAcpModelId, toAcpModelId } from "../map/models.js";
import type { PiMcpServerConfig } from "../map/mcp.js";
import { toAcpUsageUpdate } from "../map/usage.js";
import { PiRpcClient } from "../pi/rpc-client.js";
import type {
	PiImageContent,
	PiMessage,
	PiModel,
	PiPromptDisposition,
	PiRpcEvent,
	PiSessionState,
	PiStopReason,
	PiThinkingLevel,
} from "../pi/rpc-types.js";
import type { ClientPort, SessionUpdate } from "./client-port.js";
import { errorMessage, internalError, invalidRequest } from "./errors.js";
import { ExtensionDialogs } from "./extension-dialogs.js";
import { FileAccess } from "./file-access.js";
import { type ReplaySession, replayMessage } from "./replay.js";
import { ToolCalls } from "./tool-calls.js";

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

/** The pi extension that registers client-supplied MCP servers; see the file for why. */
const MCP_EXTENSION = fileURLToPath(new URL("../../pi-extension/acp-mcp-servers.js", import.meta.url));

/** Session id prefix used when pi runs without session persistence. */
export const UNPERSISTED_SESSION_PREFIX = "pi-session:";

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
	#log: (message: string) => void;
	#toolCalls: ToolCalls;
	#dialogs: ExtensionDialogs;
	#replaySession: ReplaySession;

	#queue: Promise<void> = Promise.resolve();

	#turn: { resolve: (reason: PromptStopReason) => void; reject: (error: Error) => void } | null = null;
	/** Settles once the latest prompt turn has sent its last update. */
	#turnDone: Promise<void> = Promise.resolve();
	#cancelled = false;
	#sawAgentRun = false;
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

		const session = this;
		this.#toolCalls = new ToolCalls({
			cwd: this.cwd,
			// Read lazily: `session/load` can rename the session after construction.
			get sessionId() {
				return session.sessionId;
			},
			port: this.#port,
			files: new FileAccess(this.#port, () => this.sessionId),
			notify: (update) => this.#notify(update),
		});
		this.#dialogs = new ExtensionDialogs({
			get sessionId() {
				return session.sessionId;
			},
			port: this.#port,
			toolCalls: this.#toolCalls,
			respond: (response) => this.#client.respondExtensionUi(response),
			status: (title, statusOptions) => this.#status(title, statusOptions),
			log: this.#log,
		});
		this.#replaySession = {
			ids: this.#ids,
			toolCalls: this.#toolCalls,
			notify: (update) => this.#notify(update),
			compactionSummary: async (summary) => {
				if (!this.#tracksCompactions) return;
				await this.#notify({
					sessionUpdate: "compaction_update",
					compactionId: this.#nextCompactionId(),
					status: "completed",
					summary: [{ type: "text", text: summary }],
				});
			},
		};

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
			onExtensionUiRequest: (request) => this.#enqueue(() => this.#dialogs.handle(request)),
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
	 * Resolves once that turn has sent its last update.
	 */
	async close(): Promise<void> {
		await this.cancel();
		await this.stop();
		const turn = this.#turn;
		this.#turn = null;
		this.#insertion = null;
		turn?.resolve("cancelled");
		await this.#turnDone;
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
		const turn = this.#runTurn(message, images, onInserted);
		this.#turnDone = turn.then(
			() => undefined,
			() => undefined,
		);
		return turn;
	}

	/**
	 * One prompt turn. Once pi has taken the prompt the turn is foreground work:
	 * reported `running` then, and `idle` with its stop reason after the last
	 * update it causes.
	 */
	async #runTurn(
		message: string,
		images: PiImageContent[],
		onInserted: ((messageId: string) => void) | undefined,
	): Promise<PromptStopReason> {
		this.#cancelled = false;
		this.#sawAgentRun = false;
		this.#lastStopReason = undefined;
		this.#lastErrorMessage = undefined;
		this.#toolCalls.reset();

		const settled = new Promise<PromptStopReason>((resolve, reject) => {
			this.#turn = { resolve, reject };
		});
		let inserted = false;
		this.#insertion = (messageId) => {
			inserted = true;
			onInserted?.(messageId);
			// Not awaited: sent at once, ahead of whatever the turn sends next.
			void this.#port.foreground(this.sessionId, { state: "running" });
		};

		let disposition: PiPromptDisposition;
		try {
			const response = await this.#client.request({
				type: "prompt",
				message,
				images: images.length > 0 ? images : undefined,
			});
			// pi before 1.x reports none; its prompts run like started ones.
			disposition = response?.disposition ?? "started";
		} catch (error) {
			this.#turn = null;
			this.#insertion = null;
			throw internalError(errorMessage(error));
		}
		// pi stores no user message for a prompt an extension command handled,
		// and stores a queued one only once it gets to it.
		if (disposition === "handled" || disposition === "queued") {
			this.#markInserted(this.#ids.unstoredPrompt());
		}

		// "started" and "queued" end on agent_settled, which pi always emits once
		// it has started a run.
		if (disposition === "handled" && !this.#sawAgentRun) {
			// An extension command or input handler consumed the prompt: pi will
			// not start a run for it, so there is no agent_settled to wait for.
			// Queue behind events pi already sent so their updates land first.
			this.#log('pi reported the prompt "handled" without an agent run; ending turn');
			this.#enqueue(() => this.#settleTurn());
		}
		let stopReason: PromptStopReason;
		try {
			stopReason = await settled;
		} catch (error) {
			if (inserted) {
				const code = typeof (error as { code?: unknown }).code === "number" ? (error as { code: number }).code : -32603;
				await this.#port.foreground(this.sessionId, {
					state: "idle",
					stopReason: "error",
					error: { code, message: errorMessage(error) },
				});
			}
			throw error;
		}
		await this.publishCommands();
		await this.publishConfigOptions();
		await this.publishUsage();
		if (inserted) await this.#port.foreground(this.sessionId, { state: "idle", stopReason });
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
			await replayMessage(this.#replaySession, message);
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
					return this.#port.foreground(this.sessionId, { state: "running" });
				}
				// A real agent run is under way; the turn now ends on `agent_settled`.
				this.#sawAgentRun = true;
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
				return this.#toolCalls.start(event.toolCallId, event.toolName, event.args, event.parentToolCallId);

			case "tool_execution_update":
				return this.#toolCalls.update(event.toolCallId, event.partialResult);

			case "tool_execution_end":
				return this.#toolCalls.end(event.toolCallId, event.result, event.isError);

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

			case "toolcall_start":
				// Arguments have not streamed in yet; announce the call so the client can
				// show it immediately, then refine the title once they arrive.
				return this.#toolCalls.announce(event.id, event.toolName);

			case "toolcall_end":
				return this.#toolCalls.describe(event.toolCall.id, event.toolCall.name, event.toolCall.arguments ?? {}, null);

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

	async #settleTurn(aborted = false): Promise<void> {
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
			return this.#port.foreground(this.sessionId, {
				state: "idle",
				stopReason: "error",
				error: { code: -32603, message: this.#lastErrorMessage ?? "pi run failed" },
			});
		}
		return this.#port.foreground(this.sessionId, {
			state: "idle",
			stopReason: aborted ? "cancelled" : ((stopReason && STOP_REASONS[stopReason]) ?? "end_turn"),
		});
	}

	// ==========================================================================
	// Notification helpers
	// ==========================================================================

	get #tracksCompactions(): boolean {
		return this.#port.features.compactionUpdates;
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
	 * Sent as an ACP `notice` when the client shows notices;
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

		if (this.#port.features.notices) {
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
