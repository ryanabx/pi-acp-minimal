/**
 * Structural mirror of pi's RPC protocol (`pi --mode rpc`).
 *
 * These types are copied by shape rather than imported from
 * `@earendil-works/pi-coding-agent` so the adapter stays a plain JSONL client
 * with no dependency on pi's internals. See `packages/coding-agent/docs/rpc.md`
 * in the pi repository for the authoritative protocol description.
 */

// ============================================================================
// Shared content / message shapes
// ============================================================================

export interface PiTextContent {
	type: "text";
	text: string;
}

export interface PiImageContent {
	type: "image";
	data: string;
	mimeType: string;
}

export type PiContent = PiTextContent | PiImageContent;

export interface PiToolCallContent {
	type: "toolCall";
	id: string;
	name: string;
	arguments: Record<string, unknown>;
}

export interface PiThinkingContent {
	type: "thinking";
	thinking: string;
}

export type PiAssistantContent = PiTextContent | PiThinkingContent | PiToolCallContent;

export interface PiCost {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	total: number;
}

export interface PiUsage {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	totalTokens?: number;
	cost: PiCost;
}

export type PiStopReason = "stop" | "length" | "toolUse" | "error" | "aborted";

export interface PiUserMessage {
	role: "user";
	content: string | PiContent[];
	timestamp?: number;
	attachments?: unknown[];
}

export interface PiAssistantMessage {
	role: "assistant";
	content: PiAssistantContent[];
	api?: string;
	provider?: string;
	model?: string;
	usage?: PiUsage;
	stopReason?: PiStopReason;
	errorMessage?: string;
	timestamp?: number;
}

export interface PiToolResultMessage {
	role: "toolResult";
	toolCallId: string;
	toolName: string;
	content: PiContent[];
	usage?: PiUsage;
	isError?: boolean;
	timestamp?: number;
}

export interface PiBashExecutionMessage {
	role: "bashExecution";
	command: string;
	output: string;
	exitCode: number | null;
	cancelled: boolean;
	truncated: boolean;
	fullOutputPath: string | null;
	timestamp?: number;
}

export type PiMessage = PiUserMessage | PiAssistantMessage | PiToolResultMessage | PiBashExecutionMessage;

export interface PiToolResult {
	content: PiContent[];
	details?: unknown;
}

// ============================================================================
// Model / thinking
// ============================================================================

export type PiThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

export interface PiModel {
	id: string;
	name?: string;
	api?: string;
	provider: string;
	baseUrl?: string;
	reasoning?: boolean;
	input?: string[];
	contextWindow?: number;
	maxTokens?: number;
	cost?: Omit<PiCost, "total">;
}

// ============================================================================
// Commands (adapter -> pi, stdin)
// ============================================================================

export type PiRpcCommand =
	| { type: "prompt"; message: string; images?: PiImageContent[]; streamingBehavior?: "steer" | "followUp" }
	| { type: "steer"; message: string; images?: PiImageContent[] }
	| { type: "follow_up"; message: string; images?: PiImageContent[] }
	| { type: "abort" }
	| { type: "clear_queue" }
	| { type: "new_session"; parentSession?: string }
	| { type: "get_state" }
	| { type: "set_model"; provider: string; modelId: string }
	| { type: "cycle_model" }
	| { type: "get_available_models" }
	| { type: "set_thinking_level"; level: PiThinkingLevel }
	| { type: "cycle_thinking_level" }
	| { type: "get_available_thinking_levels" }
	| { type: "set_steering_mode"; mode: "all" | "one-at-a-time" }
	| { type: "set_follow_up_mode"; mode: "all" | "one-at-a-time" }
	| { type: "compact"; customInstructions?: string }
	| { type: "set_auto_compaction"; enabled: boolean }
	| { type: "set_auto_retry"; enabled: boolean }
	| { type: "abort_retry" }
	| { type: "bash"; command: string; excludeFromContext?: boolean }
	| { type: "abort_bash" }
	| { type: "get_session_stats" }
	| { type: "export_html"; outputPath?: string }
	| { type: "switch_session"; sessionPath: string }
	| { type: "fork"; entryId: string }
	| { type: "clone" }
	| { type: "get_fork_messages" }
	| { type: "get_entries"; since?: string }
	| { type: "get_tree" }
	| { type: "get_last_assistant_text" }
	| { type: "set_session_name"; name: string }
	| { type: "get_messages" }
	| { type: "get_commands" };

export type PiRpcCommandType = PiRpcCommand["type"];

/** Maps a command type to the shape of its successful `data` payload. */
export interface PiRpcResponseData {
	prompt: undefined;
	steer: undefined;
	follow_up: undefined;
	abort: undefined;
	clear_queue: { steering: string[]; followUp: string[] };
	new_session: { cancelled: boolean };
	get_state: PiSessionState;
	set_model: PiModel;
	cycle_model: { model: PiModel; thinkingLevel: PiThinkingLevel; isScoped: boolean } | null;
	get_available_models: { models: PiModel[] };
	set_thinking_level: undefined;
	cycle_thinking_level: { level: PiThinkingLevel } | null;
	get_available_thinking_levels: { levels: PiThinkingLevel[] };
	set_steering_mode: undefined;
	set_follow_up_mode: undefined;
	compact: PiCompactionResult;
	set_auto_compaction: undefined;
	set_auto_retry: undefined;
	abort_retry: undefined;
	bash: PiBashResult;
	abort_bash: undefined;
	get_session_stats: PiSessionStats;
	export_html: { path: string };
	switch_session: { cancelled: boolean };
	fork: { text: string; cancelled: boolean };
	clone: { cancelled: boolean };
	get_fork_messages: { messages: Array<{ entryId: string; text: string }> };
	get_entries: { entries: unknown[]; leafId: string | null };
	get_tree: { tree: unknown[]; leafId: string | null };
	get_last_assistant_text: { text: string | null };
	set_session_name: undefined;
	get_messages: { messages: PiMessage[] };
	get_commands: { commands: PiSlashCommand[] };
}

export interface PiSessionState {
	model?: PiModel;
	thinkingLevel: PiThinkingLevel;
	isStreaming: boolean;
	isCompacting: boolean;
	steeringMode: "all" | "one-at-a-time";
	followUpMode: "all" | "one-at-a-time";
	sessionFile?: string;
	sessionId: string;
	sessionName?: string;
	autoCompactionEnabled: boolean;
	messageCount: number;
	pendingMessageCount: number;
}

export interface PiSessionStats {
	sessionFile?: string;
	sessionId: string;
	userMessages: number;
	assistantMessages: number;
	toolCalls: number;
	toolResults: number;
	totalMessages: number;
	tokens: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number };
	cost: number;
	contextUsage?: { tokens: number | null; contextWindow: number; percent: number | null };
}

export interface PiBashResult {
	output: string;
	exitCode: number | null;
	cancelled: boolean;
	truncated: boolean;
	fullOutputPath?: string;
}

export interface PiCompactionResult {
	summary: string;
	firstKeptEntryId?: string;
	tokensBefore?: number;
	estimatedTokensAfter?: number;
	usage?: PiUsage;
	details?: unknown;
}

/** Source metadata attached to prompt templates and skills. */
export interface PiSourceInfo {
	path?: string;
	source?: string;
	scope?: "user" | "project" | "path" | "temporary" | string;
	origin?: string;
	baseDir?: string;
}

export interface PiSlashCommand {
	name: string;
	description?: string;
	source: "extension" | "prompt" | "skill";
	/** Present in pi >= 0.8x; older builds used flat `location`/`path` fields. */
	sourceInfo?: PiSourceInfo;
	location?: string;
	path?: string;
}

// ============================================================================
// Responses (pi -> adapter, stdout)
// ============================================================================

export type PiRpcResponse =
	| { id?: string; type: "response"; command: string; success: true; data?: unknown }
	| { id?: string; type: "response"; command: string; success: false; error: string };

// ============================================================================
// Events (pi -> adapter, stdout)
// ============================================================================

export type PiAssistantMessageEvent =
	| { type: "text_start"; contentIndex: number }
	| { type: "text_delta"; contentIndex: number; delta: string }
	| { type: "text_end"; contentIndex: number; content: string }
	| { type: "thinking_start"; contentIndex: number }
	| { type: "thinking_delta"; contentIndex: number; delta: string }
	| { type: "thinking_end"; contentIndex: number; content: string }
	| { type: "toolcall_start"; contentIndex: number; id: string; toolName: string }
	| { type: "toolcall_delta"; contentIndex: number; delta: string }
	| { type: "toolcall_end"; contentIndex: number; toolCall: PiToolCallContent };

export type PiRpcEvent =
	| { type: "agent_start" }
	| { type: "agent_end"; messages: PiMessage[]; willRetry?: boolean }
	| { type: "agent_settled" }
	| { type: "turn_start" }
	| { type: "turn_end"; message: PiMessage; toolResults: PiToolResultMessage[] }
	| { type: "message_start"; message: PiMessage }
	| { type: "message_update"; usage: PiUsage; assistantMessageEvent: PiAssistantMessageEvent }
	| { type: "message_end"; message: PiMessage }
	| { type: "bash_execution_update"; id?: string; delta: string }
	| { type: "tool_execution_start"; toolCallId: string; toolName: string; args: Record<string, unknown> }
	| {
			type: "tool_execution_update";
			toolCallId: string;
			toolName: string;
			args: Record<string, unknown>;
			partialResult: PiToolResult;
	  }
	| { type: "tool_execution_end"; toolCallId: string; toolName: string; result: PiToolResult; isError: boolean }
	| { type: "queue_update"; steering: string[]; followUp: string[] }
	| { type: "compaction_start"; reason: "manual" | "threshold" | "overflow" }
	| {
			type: "compaction_end";
			reason: "manual" | "threshold" | "overflow";
			result: PiCompactionResult | null;
			aborted: boolean;
			willRetry?: boolean;
			errorMessage?: string;
	  }
	| { type: "auto_retry_start"; attempt: number; maxAttempts: number; delayMs: number; errorMessage: string }
	| { type: "auto_retry_end"; success: boolean; attempt: number; finalError?: string }
	| { type: "summarization_retry_scheduled"; attempt: number; maxAttempts: number; delayMs: number; errorMessage: string }
	| { type: "summarization_retry_attempt_start"; source: "compaction" | "branchSummary"; reason?: string }
	| { type: "summarization_retry_finished" }
	| { type: "extension_error"; extensionPath: string; event: string; error: string };

export type PiRpcEventType = PiRpcEvent["type"];

// ============================================================================
// Extension UI sub-protocol
// ============================================================================

export type PiExtensionUiRequest =
	| { type: "extension_ui_request"; id: string; method: "select"; title: string; options: string[]; timeout?: number }
	| { type: "extension_ui_request"; id: string; method: "confirm"; title: string; message: string; timeout?: number }
	| { type: "extension_ui_request"; id: string; method: "input"; title: string; placeholder?: string; timeout?: number }
	| { type: "extension_ui_request"; id: string; method: "editor"; title: string; prefill?: string }
	| {
			type: "extension_ui_request";
			id: string;
			method: "notify";
			message: string;
			notifyType?: "info" | "warning" | "error";
	  }
	| { type: "extension_ui_request"; id: string; method: "setStatus"; statusKey: string; statusText?: string }
	| {
			type: "extension_ui_request";
			id: string;
			method: "setWidget";
			widgetKey: string;
			widgetLines?: string[];
			widgetPlacement?: "aboveEditor" | "belowEditor";
	  }
	| { type: "extension_ui_request"; id: string; method: "setTitle"; title: string }
	| { type: "extension_ui_request"; id: string; method: "set_editor_text"; text: string };

export type PiExtensionUiResponse =
	| { type: "extension_ui_response"; id: string; value: string }
	| { type: "extension_ui_response"; id: string; confirmed: boolean }
	| { type: "extension_ui_response"; id: string; cancelled: true };

/** Anything pi can write on stdout. */
export type PiStdoutMessage = PiRpcResponse | PiRpcEvent | PiExtensionUiRequest;
