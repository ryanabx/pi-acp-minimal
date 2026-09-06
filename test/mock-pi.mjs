#!/usr/bin/env node
/**
 * A stand-in for `pi --mode rpc`.
 *
 * Speaks pi's JSONL RPC protocol with deterministic, scripted behaviour so the
 * adapter can be exercised end to end without a provider or an LLM. The prompt
 * text selects the scenario; see `scenarios` below.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { StringDecoder } from "node:string_decoder";

const sessionDir = process.env.MOCK_PI_SESSION_DIR ?? process.cwd();
mkdirSync(sessionDir, { recursive: true });

const state = {
	sessionId: "mock-session-1",
	sessionFile: path.join(sessionDir, "mock-session-1.jsonl"),
	thinkingLevel: "off",
	isStreaming: false,
	isCompacting: false,
	steeringMode: "one-at-a-time",
	followUpMode: "one-at-a-time",
	autoCompactionEnabled: true,
	messageCount: 0,
	pendingMessageCount: 0,
	model: model("anthropic", "claude-sonnet-4", "Claude Sonnet 4", true),
};

const models = [
	model("anthropic", "claude-sonnet-4", "Claude Sonnet 4", true),
	// Deliberately without reasoning support, mirroring a local llama.cpp model:
	// pi clamps every thinking level to "off" for these.
	model("openai", "gpt-5", "GPT-5", false),
];

/** `--session <path>` resumes a transcript, exactly as pi's CLI does. */
const resumeIndex = process.argv.indexOf("--session");
if (resumeIndex !== -1 && process.argv[resumeIndex + 1]) {
	state.sessionFile = process.argv[resumeIndex + 1];
}

const messages = existsSync(state.sessionFile) ? JSON.parse(readFileSync(state.sessionFile, "utf8")) : [];
let aborted = false;
/** Set by the NOSTATS scenario to mimic pi having no context figure to report. */
let noContextUsage = process.env.MOCK_PI_NO_CONTEXT_USAGE === "1";

function persist() {
	state.messageCount = messages.length;
	writeFileSync(state.sessionFile, JSON.stringify(messages));
}

function model(provider, id, name, reasoning) {
	return {
		id,
		name,
		api: `${provider}-messages`,
		provider,
		reasoning,
		input: ["text", "image"],
		contextWindow: 200000,
		maxTokens: 16384,
		cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
	};
}

/** pi only offers a choice of levels for models with reasoning support. */
function thinkingLevels() {
	return state.model.reasoning ? ["off", "low", "medium", "high"] : ["off"];
}

function write(value) {
	process.stdout.write(`${JSON.stringify(value)}\n`);
}

const usage = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };

function delta(assistantMessageEvent) {
	write({ type: "message_update", usage, assistantMessageEvent });
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ============================================================================
// Scenarios, keyed by a marker inside the prompt text
// ============================================================================

const scenarios = [
	{ match: /\bTEXT\b/, run: textScenario },
	{ match: /\bTHINK\b/, run: thinkScenario },
	{ match: /\bEDIT\b/, run: editScenario },
	{ match: /\bBASH\b/, run: bashScenario },
	{ match: /\bTOOLFAIL\b/, run: toolFailScenario },
	{ match: /\bERROR\b/, run: errorScenario },
	{ match: /\bRETRY\b/, run: retryScenario },
	{ match: /\bSLOW\b/, run: slowScenario },
	{ match: /\bCONFIRM\b/, run: confirmScenario },
	{ match: /\bNOTIFY\b/, run: notifyScenario },
	{ match: /\bNOOP\b/, run: noopScenario },
	{ match: /\bMODELCHANGE\b/, run: modelChangeScenario },
	{ match: /\bNOSTATS\b/, run: noStatsScenario },
];

function startAssistant() {
	write({ type: "turn_start" });
	write({
		type: "message_start",
		message: { role: "assistant", content: [], provider: "anthropic", model: "claude-sonnet-4", usage, timestamp: Date.now() },
	});
}

function endAssistant(content, stopReason, errorMessage) {
	const message = {
		role: "assistant",
		content,
		provider: "anthropic",
		model: "claude-sonnet-4",
		usage,
		stopReason,
		timestamp: Date.now(),
	};
	if (errorMessage) message.errorMessage = errorMessage;
	messages.push(message);
	persist();
	write({ type: "message_end", message });
	write({ type: "turn_end", message, toolResults: [] });
}

async function textScenario() {
	startAssistant();
	delta({ type: "text_start", contentIndex: 0 });
	for (const chunk of ["Hello", ", ", "world!"]) {
		delta({ type: "text_delta", contentIndex: 0, delta: chunk });
		await sleep(5);
	}
	delta({ type: "text_end", contentIndex: 0, content: "Hello, world!" });
	endAssistant([{ type: "text", text: "Hello, world!" }], "stop");
}

async function thinkScenario() {
	startAssistant();
	delta({ type: "thinking_start", contentIndex: 0 });
	delta({ type: "thinking_delta", contentIndex: 0, delta: "pondering" });
	delta({ type: "thinking_end", contentIndex: 0, content: "pondering" });
	delta({ type: "text_start", contentIndex: 1 });
	delta({ type: "text_delta", contentIndex: 1, delta: "done thinking" });
	delta({ type: "text_end", contentIndex: 1, content: "done thinking" });
	endAssistant([{ type: "thinking", thinking: "pondering" }, { type: "text", text: "done thinking" }], "stop");
}

async function editScenario() {
	const target = path.join(process.cwd(), "edited.txt");
	writeFileSync(target, "before\n");
	const args = { path: "edited.txt", content: "after\n" };

	startAssistant();
	delta({ type: "toolcall_start", contentIndex: 0, id: "call-edit", toolName: "write" });
	delta({ type: "toolcall_delta", contentIndex: 0, delta: JSON.stringify(args) });
	delta({ type: "toolcall_end", contentIndex: 0, toolCall: { type: "toolCall", id: "call-edit", name: "write", arguments: args } });

	write({ type: "tool_execution_start", toolCallId: "call-edit", toolName: "write", args });
	await sleep(10);
	writeFileSync(target, "after\n");
	write({
		type: "tool_execution_end",
		toolCallId: "call-edit",
		toolName: "write",
		result: { content: [{ type: "text", text: "Wrote 1 line" }], details: { bytes: 6 } },
		isError: false,
	});
	endAssistant([{ type: "toolCall", id: "call-edit", name: "write", arguments: args }], "toolUse");
}

async function bashScenario() {
	const args = { command: "echo hi" };
	startAssistant();
	delta({ type: "toolcall_start", contentIndex: 0, id: "call-bash", toolName: "bash" });
	delta({ type: "toolcall_end", contentIndex: 0, toolCall: { type: "toolCall", id: "call-bash", name: "bash", arguments: args } });
	write({ type: "tool_execution_start", toolCallId: "call-bash", toolName: "bash", args });
	write({
		type: "tool_execution_update",
		toolCallId: "call-bash",
		toolName: "bash",
		args,
		partialResult: { content: [{ type: "text", text: "hi" }], details: {} },
	});
	write({
		type: "tool_execution_end",
		toolCallId: "call-bash",
		toolName: "bash",
		result: { content: [{ type: "text", text: "hi\n" }], details: { exitCode: 0 } },
		isError: false,
	});
	endAssistant([{ type: "toolCall", id: "call-bash", name: "bash", arguments: args }], "toolUse");
}

async function toolFailScenario() {
	const args = { path: "missing.txt" };
	startAssistant();
	delta({ type: "toolcall_start", contentIndex: 0, id: "call-read", toolName: "read" });
	delta({ type: "toolcall_end", contentIndex: 0, toolCall: { type: "toolCall", id: "call-read", name: "read", arguments: args } });
	write({ type: "tool_execution_start", toolCallId: "call-read", toolName: "read", args });
	write({
		type: "tool_execution_end",
		toolCallId: "call-read",
		toolName: "read",
		result: { content: [{ type: "text", text: "ENOENT: no such file" }], details: {} },
		isError: true,
	});
	endAssistant([{ type: "toolCall", id: "call-read", name: "read", arguments: args }], "toolUse");
}

async function errorScenario() {
	startAssistant();
	endAssistant([], "error", "Connection error.");
}

async function retryScenario() {
	startAssistant();
	endAssistant([], "error", "Overloaded");
	write({ type: "agent_end", messages: [], willRetry: true });
	write({ type: "auto_retry_start", attempt: 1, maxAttempts: 3, delayMs: 2000, errorMessage: "Overloaded" });
	await sleep(10);
	write({ type: "auto_retry_end", success: true, attempt: 2 });
	await textScenario();
}

async function slowScenario() {
	startAssistant();
	delta({ type: "text_start", contentIndex: 0 });
	for (let i = 0; i < 100 && !aborted; i++) {
		delta({ type: "text_delta", contentIndex: 0, delta: "." });
		await sleep(20);
	}
	endAssistant([{ type: "text", text: "." }], aborted ? "aborted" : "stop");
}

async function confirmScenario() {
	write({ type: "extension_ui_request", id: "ui-1", method: "confirm", title: "Run dangerous command?", message: "rm -rf /tmp/x" });
	const answer = await waitForUiResponse("ui-1");
	startAssistant();
	const text = answer.confirmed ? "confirmed" : "declined";
	delta({ type: "text_start", contentIndex: 0 });
	delta({ type: "text_delta", contentIndex: 0, delta: text });
	delta({ type: "text_end", contentIndex: 0, content: text });
	endAssistant([{ type: "text", text }], "stop");
}

async function notifyScenario() {
	write({ type: "extension_ui_request", id: "ui-2", method: "notify", message: "heads up", notifyType: "warning" });
	await textScenario();
}

/** llama.cpp only reports a model's real context window once it is loaded. */
async function modelChangeScenario() {
	models[0].contextWindow = 99328;
	await textScenario();
}

/** pi reports no context figure right after compaction, or with no model. */
async function noStatsScenario() {
	noContextUsage = true;
	await textScenario();
}

/** A prompt handled entirely by an extension: no agent run at all. */
async function noopScenario() {
	return "no-agent-run";
}

// ============================================================================
// Command loop
// ============================================================================

const uiWaiters = new Map();

function waitForUiResponse(id) {
	return new Promise((resolve) => uiWaiters.set(id, resolve));
}

async function runPrompt(message) {
	aborted = false;
	messages.push({ role: "user", content: [{ type: "text", text: message }], timestamp: Date.now() });
	if (!/\bNOOP\b/.test(message)) write({ type: "agent_start" });
	write({ type: "message_start", message: messages.at(-1) });
	write({ type: "message_end", message: messages.at(-1) });

	const scenario = scenarios.find((entry) => entry.match.test(message));
	if (scenario && (await scenario.run()) === "no-agent-run") {
		// An extension handled the prompt inline: no agent run, no agent_settled.
		state.isStreaming = false;
		persist();
		return;
	}
	if (!scenario) await textScenario();

	write({ type: "agent_end", messages: [], willRetry: false });
	state.isStreaming = false;
	persist();
	write({ type: "agent_settled" });
}

function success(id, command, data) {
	const response = { type: "response", command, success: true };
	if (id !== undefined) response.id = id;
	if (data !== undefined) response.data = data;
	write(response);
}

function failure(id, command, error) {
	write({ id, type: "response", command, success: false, error });
}

async function handleCommand(command) {
	const { id, type } = command;
	switch (type) {
		case "get_state":
			return success(id, type, { ...state });
		case "get_available_models":
			return success(id, type, { models });
		case "get_available_thinking_levels":
			// MOCK_PI_NO_THINKING_LEVELS mimics a pi build that cannot answer.
			if (process.env.MOCK_PI_NO_THINKING_LEVELS === "1") return success(id, type, { levels: [] });
			return success(id, type, { levels: thinkingLevels() });
		case "get_commands":
			return success(id, type, {
				commands: [
					{ name: "review", description: "Review the diff", source: "prompt", sourceInfo: { scope: "project" } },
					{ name: "skill:search", description: "Search the web", source: "skill", sourceInfo: { scope: "user" } },
				],
			});
		case "get_messages":
			return success(id, type, { messages });
		case "get_session_stats": {
			// Grows with the transcript so tests can watch context fill up.
			const used = messages.length * 100;
			return success(id, type, {
				sessionFile: state.sessionFile,
				sessionId: state.sessionId,
				userMessages: messages.filter((m) => m.role === "user").length,
				assistantMessages: messages.filter((m) => m.role === "assistant").length,
				toolCalls: 0,
				toolResults: 0,
				totalMessages: messages.length,
				tokens: { input: used, output: 0, cacheRead: 0, cacheWrite: 0, total: used },
				cost: used * 0.00001,
				...(noContextUsage ? {} : { contextUsage: { tokens: used, contextWindow: 200000, percent: used / 2000 } }),
			});
		}
		case "set_model": {
			const found = models.find((m) => m.provider === command.provider && m.id === command.modelId);
			if (!found) return failure(id, type, `Model not found: ${command.provider}/${command.modelId}`);
			state.model = found;
			return success(id, type, found);
		}
		case "set_thinking_level": {
			// Mirror pi: clamp to what the model supports, and report success anyway.
			const available = thinkingLevels();
			state.thinkingLevel = available.includes(command.level) ? command.level : available[available.length - 1];
			return success(id, type);
		}
		case "abort":
			aborted = true;
			return success(id, type);
		case "prompt": {
			state.isStreaming = true;
			success(id, type);
			void runPrompt(command.message).catch((error) => {
				process.stderr.write(`mock-pi scenario failed: ${error?.stack ?? error}\n`);
			});
			return;
		}
		default:
			return failure(id, type, `mock-pi does not implement "${type}"`);
	}
}

const decoder = new StringDecoder("utf8");
let buffer = "";
process.stdin.on("data", (chunk) => {
	buffer += decoder.write(chunk);
	let index;
	while ((index = buffer.indexOf("\n")) !== -1) {
		const line = buffer.slice(0, index).replace(/\r$/, "");
		buffer = buffer.slice(index + 1);
		if (!line.trim()) continue;
		const message = JSON.parse(line);
		if (message.type === "extension_ui_response") {
			uiWaiters.get(message.id)?.(message);
			uiWaiters.delete(message.id);
			continue;
		}
		void handleCommand(message);
	}
});
process.stdin.on("end", () => process.exit(0));
