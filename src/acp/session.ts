import type {
	AgentSideConnection,
	AvailableCommand,
	ClientCapabilities,
	ContentBlock,
	PermissionOption,
	SessionConfigOption,
	PromptResponse,
	SessionNotification,
	ToolCallContent,
	ToolCallLocation,
	ToolCallStatus,
	ToolKind,
} from "@agentclientprotocol/sdk";
import { toAcpCommand } from "../map/commands.js";
import { assistantText, toAcpContentBlocks } from "../map/content.js";
import { buildConfigOptions } from "../map/config.js";
import { fromAcpModelId, toAcpModelId } from "../map/models.js";
import { isFileMutatingTool, resolvePath, toolKind, toolLocations, toolTitle } from "../map/tools.js";
import { toAcpUsageUpdate } from "../map/usage.js";
import { PiRpcClient } from "../pi/rpc-client.js";
import type {
	PiExtensionUiRequest,
	PiImageContent,
	PiMessage,
	PiModel,
	PiRpcEvent,
	PiSessionState,
	PiStopReason,
	PiThinkingLevel,
	PiToolResult,
} from "../pi/rpc-types.js";
import { internalError, invalidRequest } from "./errors.js";
import { FileAccess } from "./file-access.js";

/** ACP `session/prompt` stop reasons. */
type PromptStopReason = PromptResponse["stopReason"];

export interface PiSessionOptions {
	connection: AgentSideConnection;
	clientCapabilities: ClientCapabilities | undefined;
	cwd: string;
	/** Executable used to launch pi; when omitted, `pi` is located on `PATH`. */
	piCommand?: string;
	piArgs: string[];
	env?: NodeJS.ProcessEnv;
	/** Existing pi session file to resume, for `session/load`. */
	resumeSessionFile?: string;
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
}

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

	#connection: AgentSideConnection;
	#clientCapabilities: ClientCapabilities | undefined;
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
	#idleWatchdog: NodeJS.Timeout | null = null;
	#idleObservations = 0;
	#lastStopReason: PiStopReason | undefined;
	#lastErrorMessage: string | undefined;
	#streamedTextThisMessage = false;

	#models: PiModel[] = [];
	#currentModelId: string | undefined;
	/** pi's supported levels; empty until known, or if pi cannot say. */
	#thinkingLevels: PiThinkingLevel[] = [];
	#thinkingLevel: PiThinkingLevel = "off";
	#commandSignature = "";
	#configSignature = "";
	#usageSignature = "";

	constructor(options: PiSessionOptions) {
		this.cwd = options.cwd;
		this.#connection = options.connection;
		this.#clientCapabilities = options.clientCapabilities;
		this.#log = options.log;

		const args = [...options.piArgs];
		if (options.resumeSessionFile) args.push("--session", options.resumeSessionFile);

		this.#client = new PiRpcClient({
			command: options.piCommand,
			args,
			cwd: options.cwd,
			env: options.env,
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
		this.#files = new FileAccess(this.#connection, this.#clientCapabilities, () => this.sessionId);

		await this.refreshModelState(state);
		await this.refreshThinkingState(state);
		// Seed the signature: session/new carries these options in its response.
		this.#configSignature = JSON.stringify(this.configOptions());
	}

	async stop(): Promise<void> {
		await this.#client.stop();
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
	 * Publish commands and usage once the caller's own response has been sent.
	 *
	 * Used by `session/new`, where notifying before the response would reference a
	 * session the client has not registered yet.
	 */
	publishSessionStateSoon(): void {
		queueMicrotask(() => {
			void (async () => {
				await this.publishCommands();
				await this.publishUsage();
			})().catch((error: unknown) => {
				this.#log(`failed to publish initial session state: ${errorMessage(error)}`);
			});
		});
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

	async prompt(message: string, images: PiImageContent[]): Promise<PromptStopReason> {
		if (this.#turn) throw invalidRequest("A prompt turn is already in progress for this session");

		this.#cancelled = false;
		this.#sawAgentRun = false;
		this.#lastStopReason = undefined;
		this.#lastErrorMessage = undefined;
		this.#toolCalls.clear();
		this.#activeToolCallId = null;

		const settled = new Promise<PromptStopReason>((resolve, reject) => {
			this.#turn = { resolve, reject };
		});

		try {
			await this.#client.request({ type: "prompt", message, images: images.length > 0 ? images : undefined });
		} catch (error) {
			this.#turn = null;
			throw internalError(errorMessage(error));
		}

		this.#startIdleWatchdog();
		const stopReason = await settled;
		await this.publishCommands();
		await this.publishConfigOptions();
		await this.publishUsage();
		return stopReason;
	}

	async cancel(): Promise<void> {
		if (!this.#turn) return;
		this.#cancelled = true;
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
				for (const content of toAcpContentBlocks(message.content)) {
					await this.#notify({ sessionUpdate: "user_message_chunk", content });
				}
				return;
			}
			case "assistant": {
				for (const part of message.content) {
					if (part.type === "text") {
						if (part.text) {
							await this.#notify({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: part.text } });
						}
					} else if (part.type === "thinking") {
						if (part.thinking) {
							await this.#notify({
								sessionUpdate: "agent_thought_chunk",
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
						content: { type: "text", text: `\n_pi error: ${message.errorMessage}_\n` },
					});
				}
				return;
			}
			case "toolResult": {
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
				await this.#notify({ sessionUpdate: "user_message_chunk", content: { type: "text", text } });
				return;
			}
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
				// A real agent run is under way; the turn now ends on `agent_settled`.
				this.#sawAgentRun = true;
				this.#stopIdleWatchdog();
				return;

			case "message_start":
				if (event.message.role === "assistant") this.#streamedTextThisMessage = false;
				return;

			case "message_update":
				return this.#handleMessageUpdate(event.assistantMessageEvent);

			case "message_end":
				return this.#handleMessageEnd(event.message);

			case "tool_execution_start":
				return this.#handleToolStart(event.toolCallId, event.toolName, event.args);

			case "tool_execution_update":
				return this.#handleToolUpdate(event.toolCallId, event.partialResult);

			case "tool_execution_end":
				return this.#handleToolEnd(event.toolCallId, event.result, event.isError);

			case "turn_end":
				// Progressive reporting: a long agentic run fills the context well
				// before the prompt turn as a whole finishes.
				return this.publishUsage();

			case "agent_settled":
				return this.#settleTurn();

			case "compaction_start":
				return this.#status(`Compacting context (${event.reason})…`);

			case "compaction_end": {
				if (event.aborted) return this.#status("Compaction aborted.");
				if (!event.result) return this.#status(`Compaction failed: ${event.errorMessage ?? "unknown error"}`);
				const before = event.result.tokensBefore;
				const after = event.result.estimatedTokensAfter;
				const detail = before && after ? ` (~${before} → ~${after} tokens)` : "";
				return this.#status(`Context compacted${detail}.`);
			}

			case "auto_retry_start":
				return this.#status(
					`Retrying after error (attempt ${event.attempt}/${event.maxAttempts}, ` +
						`waiting ${Math.round(event.delayMs / 1000)}s): ${event.errorMessage}`,
				);

			case "auto_retry_end":
				if (event.success) return this.#status(`Retry succeeded on attempt ${event.attempt}.`);
				return this.#status(`Retries exhausted after ${event.attempt} attempts: ${event.finalError ?? "unknown error"}`);

			case "summarization_retry_scheduled":
				return this.#status(
					`Retrying summarization (attempt ${event.attempt}/${event.maxAttempts}): ${event.errorMessage}`,
				);

			case "extension_error":
				this.#log(`extension error in ${event.extensionPath} (${event.event}): ${event.error}`);
				return this.#status(`Extension error (${event.event}): ${event.error}`);

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
				return this.#notify({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: event.delta } });

			case "thinking_delta":
				if (!event.delta) return;
				return this.#notify({ sessionUpdate: "agent_thought_chunk", content: { type: "text", text: event.delta } });

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
				await this.#notify({ sessionUpdate: "agent_message_chunk", content: { type: "text", text } });
			}
		}
		this.#streamedTextThisMessage = false;
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

	async #handleToolStart(toolCallId: string, toolName: string, args: Record<string, unknown>): Promise<void> {
		this.#activeToolCallId = toolCallId;
		await this.#describeToolCall(toolCallId, toolName, args, "in_progress");

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
		const content = toolResultContent(partialResult);
		if (content.length === 0) return;
		return this.#notify({ sessionUpdate: "tool_call_update", toolCallId, status: "in_progress", content });
	}

	async #handleToolEnd(toolCallId: string, result: PiToolResult | undefined, isError: boolean): Promise<void> {
		if (this.#activeToolCallId === toolCallId) this.#activeToolCallId = null;

		const state = this.#toolCalls.get(toolCallId);
		if (state) state.status = isError ? "failed" : "completed";

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

	/**
	 * Guard against prompts that never start an agent run.
	 *
	 * Extension commands (`/mycommand`) are handled inline by pi and may finish
	 * without emitting `agent_start`/`agent_settled`, which would leave
	 * `session/prompt` pending forever. Poll pi until it has been idle for a
	 * few consecutive checks, then end the turn ourselves.
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
		this.#log("prompt completed without an agent run (extension command); ending turn");
		this.#enqueue(() => this.#settleTurn());
	}

	async #settleTurn(): Promise<void> {
		this.#stopIdleWatchdog();
		const turn = this.#turn;
		if (!turn) return;
		this.#turn = null;

		if (this.#cancelled) return turn.resolve("cancelled");

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
		turn.reject(error);
	}

	// ==========================================================================
	// Extension UI bridge
	// ==========================================================================

	async #handleExtensionUi(request: PiExtensionUiRequest): Promise<void> {
		switch (request.method) {
			case "notify":
				return this.#status(request.message, request.notifyType);

			case "confirm":
				return this.#askPermission(
					request.id,
					request.message ? `${request.title}\n\n${request.message}` : request.title,
					[
						{ optionId: "yes", name: "Yes", kind: "allow_once" },
						{ optionId: "no", name: "No", kind: "reject_once" },
					],
					(optionId) => ({ type: "extension_ui_response", id: request.id, confirmed: optionId === "yes" }),
					{ type: "extension_ui_response", id: request.id, confirmed: false },
				);

			case "select":
				return this.#askPermission(
					request.id,
					request.title,
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
				);

			case "input":
			case "editor":
				// ACP has no free-text prompt; decline so the extension takes its
				// cancellation path instead of blocking pi forever.
				this.#client.respondExtensionUi({ type: "extension_ui_response", id: request.id, cancelled: true });
				return this.#status(
					`A pi extension asked for text input ("${request.title}"), which ACP cannot display. The request was cancelled.`,
					"warning",
				);

			default:
				// setStatus / setWidget / setTitle / set_editor_text are TUI chrome.
				this.#log(`ignoring extension UI request: ${request.method}`);
				return;
		}
	}

	/**
	 * Render a pi extension dialog as an ACP permission request.
	 *
	 * ACP permission requests hang off a tool call, so when no tool is running
	 * the dialog gets a synthetic one to anchor it in the client's transcript.
	 */
	async #askPermission(
		requestId: string,
		title: string,
		options: PermissionOption[],
		toResponse: (optionId: string) => Parameters<PiRpcClient["respondExtensionUi"]>[0],
		onCancel: Parameters<PiRpcClient["respondExtensionUi"]>[0],
	): Promise<void> {
		const existing = this.#activeToolCallId;
		const toolCallId = existing ?? `pi-dialog-${requestId}`;
		const existingTitle = existing ? this.#toolCalls.get(existing)?.title : undefined;
		const promptTitle = existingTitle ? `${existingTitle} — ${title}` : title;

		if (!existing) {
			await this.#notify({
				sessionUpdate: "tool_call",
				toolCallId,
				title,
				kind: "other",
				status: "pending",
			});
		}

		// Not awaited: pi is blocked on this dialog, and holding the event queue
		// would stall any tool output still streaming alongside it.
		void this.#connection
			.requestPermission({
				sessionId: this.sessionId,
				options,
				toolCall: { toolCallId, title: promptTitle, ...(existing ? {} : { kind: "other" as const }) },
			})
			.then(
				(response) => {
					const outcome = response.outcome;
					const answer = outcome.outcome === "selected" ? toResponse(outcome.optionId) : onCancel;
					this.#client.respondExtensionUi(answer);
					if (!existing) {
						this.#enqueue(() =>
							this.#notify({
								sessionUpdate: "tool_call_update",
								toolCallId,
								status: outcome.outcome === "selected" ? "completed" : "failed",
							}),
						);
					}
				},
				(error: unknown) => {
					this.#log(`permission request failed: ${errorMessage(error)}`);
					this.#client.respondExtensionUi(onCancel);
				},
			);
	}

	// ==========================================================================
	// Notification helpers
	// ==========================================================================

	/** Out-of-band progress text, rendered as an italic agent message line. */
	async #status(message: string, level: "info" | "warning" | "error" = "info"): Promise<void> {
		const prefix = level === "error" ? "⚠ " : level === "warning" ? "⚠ " : "";
		await this.#notify({
			sessionUpdate: "agent_message_chunk",
			content: { type: "text", text: `\n_${prefix}${message.replace(/\n+/g, " ")}_\n` },
		});
	}

	async #notify(update: SessionNotification["update"]): Promise<void> {
		await this.#connection.sessionUpdate({ sessionId: this.sessionId, update });
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

export function errorMessage(error: unknown): string {
	if (error instanceof Error) return error.message;
	return String(error);
}


