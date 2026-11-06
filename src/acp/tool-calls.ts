import type { ContentBlock, ToolCallContent, ToolCallLocation, ToolCallStatus, ToolKind } from "@agentclientprotocol/sdk";
import { contentToText, toAcpContentBlocks } from "../map/content.js";
import {
	appendedOutput,
	isFileMutatingTool,
	isShellTool,
	resolvePath,
	toolKind,
	toolLocations,
	toolTitle,
} from "../map/tools.js";
import type { PiToolResult, PiToolResultMessage } from "../pi/rpc-types.js";
import type { ClientPort, SessionUpdate } from "./client-port.js";
import type { FileAccess } from "./file-access.js";

/** What a {@link ToolCalls} needs from the session it belongs to. */
export interface ToolCallsSession {
	readonly cwd: string;
	readonly sessionId: string;
	readonly port: ClientPort;
	readonly files: FileAccess;
	notify(update: SessionUpdate): Promise<void>;
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

/**
 * The tool calls of one session, from pi's events to ACP tool call updates.
 *
 * A call is announced as soon as pi starts streaming it and refined as its
 * arguments, execution and result arrive. `edit` and `write` calls get a diff
 * from a snapshot of the file taken before they run. Shell output goes to a
 * display terminal named after the call when the client shows them (ACP v2),
 * and is text content on the call otherwise.
 */
export class ToolCalls {
	#calls = new Map<string, ToolCallState>();
	/** Most recent top-level tool call still executing; extension dialogs attach to it. */
	#active: string | null = null;

	constructor(private readonly session: ToolCallsSession) {}

	/** Forget every call: a new prompt turn starts. */
	reset(): void {
		this.#calls.clear();
		this.#active = null;
	}

	/** The tool call an extension dialog opened now belongs to, if any. */
	active(): { toolCallId: string; title?: string } | undefined {
		if (!this.#active) return undefined;
		const title = this.#calls.get(this.#active)?.title;
		return { toolCallId: this.#active, ...(title ? { title } : {}) };
	}

	/** pi started streaming a call; its arguments have not arrived yet. */
	async announce(toolCallId: string, toolName: string): Promise<void> {
		const state: ToolCallState = {
			toolName,
			title: toolTitle(this.session.cwd, toolName),
			kind: toolKind(toolName),
			status: "pending",
			locations: [],
			announced: true,
		};
		this.#calls.set(toolCallId, state);
		await this.session.notify({
			sessionUpdate: "tool_call",
			toolCallId,
			title: state.title,
			kind: state.kind,
			status: "pending",
		});
	}

	/** Fill in everything derivable from a call's complete arguments. */
	async describe(
		toolCallId: string,
		toolName: string,
		args: Record<string, unknown>,
		status: ToolCallStatus | null,
	): Promise<void> {
		const { cwd } = this.session;
		const state = this.#calls.get(toolCallId) ?? {
			toolName,
			title: toolTitle(cwd, toolName, args),
			kind: toolKind(toolName),
			status: "pending" as ToolCallStatus,
			locations: [],
			announced: false,
		};

		state.args = args;
		state.title = toolTitle(cwd, toolName, args);
		state.kind = toolKind(toolName);
		state.locations = toolLocations(cwd, toolName, args);
		if (status) state.status = status;
		this.#calls.set(toolCallId, state);

		const fields = {
			toolCallId,
			title: state.title,
			kind: state.kind,
			status: state.status,
			rawInput: args,
			locations: state.locations,
		};
		if (!state.announced) {
			state.announced = true;
			return this.session.notify({ sessionUpdate: "tool_call", ...fields });
		}
		return this.session.notify({ sessionUpdate: "tool_call_update", ...fields });
	}

	async start(
		toolCallId: string,
		toolName: string,
		args: Record<string, unknown>,
		parentToolCallId: string | undefined,
	): Promise<void> {
		// A call a tool makes through `ctx.executeTool()` still shows as its own
		// tool call, but the calling tool stays the one a dialog belongs to:
		// otherwise the nested call's end would leave no active tool call behind.
		if (!parentToolCallId) this.#active = toolCallId;
		await this.describe(toolCallId, toolName, args, "in_progress");

		const state = this.#calls.get(toolCallId);
		if (!state) return;
		if (isShellTool(toolName) && this.#showsTerminals) await this.#openTerminal(toolCallId, state);

		// Snapshot the file before it changes so the completion can carry a real diff.
		if (isFileMutatingTool(toolName)) {
			const rawPath = typeof args.path === "string" ? args.path : undefined;
			if (rawPath) {
				state.filePath = resolvePath(this.session.cwd, rawPath);
				state.oldText = await this.session.files.readText(state.filePath);
			}
		}
	}

	async update(toolCallId: string, partialResult: PiToolResult | undefined): Promise<void> {
		const state = this.#calls.get(toolCallId);
		if (state?.terminalOutput !== undefined) {
			return this.#writeTerminal(toolCallId, state, contentToText(partialResult?.content));
		}
		const content = toolResultContent(partialResult);
		if (content.length === 0) return;
		return this.session.notify({ sessionUpdate: "tool_call_update", toolCallId, status: "in_progress", content });
	}

	async end(toolCallId: string, result: PiToolResult | undefined, isError: boolean): Promise<void> {
		if (this.#active === toolCallId) this.#active = null;

		const state = this.#calls.get(toolCallId);
		if (state) state.status = isError ? "failed" : "completed";
		if (state?.terminalOutput !== undefined) return this.#closeTerminal(toolCallId, state, result, isError);

		const content: ToolCallContent[] = [];
		if (state && !isError && isFileMutatingTool(state.toolName) && state.filePath) {
			const newText = await this.session.files.readText(state.filePath);
			if (newText !== null) {
				content.push({ type: "diff", path: state.filePath, oldText: state.oldText ?? null, newText });
			}
		}
		if (content.length === 0) content.push(...toolResultContent(result));

		const details = result?.details;
		await this.session.notify({
			sessionUpdate: "tool_call_update",
			toolCallId,
			status: isError ? "failed" : "completed",
			content,
			...(isPlainObject(details) ? { rawOutput: details } : {}),
		});
	}

	/** A call from stored history, as `session/load` replays it. */
	async replayCall(toolCallId: string, toolName: string, args: Record<string, unknown>): Promise<void> {
		const { cwd } = this.session;
		// Left in_progress: the matching toolResult message completes it, and an
		// interrupted session honestly has none.
		const state: ToolCallState = {
			toolName,
			title: toolTitle(cwd, toolName, args),
			kind: toolKind(toolName),
			status: "in_progress",
			args,
			locations: toolLocations(cwd, toolName, args),
			announced: true,
		};
		this.#calls.set(toolCallId, state);
		await this.session.notify({
			sessionUpdate: "tool_call",
			toolCallId,
			title: state.title,
			kind: state.kind,
			status: state.status,
			rawInput: args,
			locations: state.locations,
		});
	}

	/** A call's result from stored history. */
	async replayResult(message: PiToolResultMessage): Promise<void> {
		const state = this.#calls.get(message.toolCallId);
		if (state && isShellTool(message.toolName) && this.#showsTerminals) {
			await this.#openTerminal(message.toolCallId, state);
			return this.#closeTerminal(message.toolCallId, state, message, message.isError === true);
		}
		await this.session.notify({
			sessionUpdate: "tool_call_update",
			toolCallId: message.toolCallId,
			status: message.isError ? "failed" : "completed",
			content: toolResultContent({ content: message.content }),
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
		return this.session.port.features.displayTerminals;
	}

	async #openTerminal(toolCallId: string, state: ToolCallState): Promise<void> {
		if (state.terminalOutput !== undefined) return;
		state.terminalOutput = "";
		const command = typeof state.args?.command === "string" ? state.args.command : undefined;
		// The terminal exists before the tool call refers to it.
		await this.session.port.terminal(this.session.sessionId, {
			type: "open",
			terminalId: toolCallId,
			cwd: this.session.cwd,
			...(command ? { command } : {}),
		});
		await this.session.notify({
			sessionUpdate: "tool_call_update",
			toolCallId,
			content: [{ type: "terminal", terminalId: toolCallId }],
		});
	}

	async #writeTerminal(toolCallId: string, state: ToolCallState, snapshot: string): Promise<void> {
		const data = appendedOutput(state.terminalOutput ?? "", snapshot);
		state.terminalOutput = snapshot;
		if (!data) return;
		await this.session.port.terminal(this.session.sessionId, { type: "output", terminalId: toolCallId, data });
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
		await this.session.port.terminal(this.session.sessionId, { type: "exit", terminalId: toolCallId, exitCode });
		const details = result?.details;
		await this.session.notify({
			sessionUpdate: "tool_call_update",
			toolCallId,
			status: isError ? "failed" : "completed",
			content: [{ type: "terminal", terminalId: toolCallId }],
			...(isPlainObject(details) ? { rawOutput: details } : {}),
		});
	}
}

/** pi tool output -> ACP tool call content blocks. */
function toolResultContent(result: PiToolResult | undefined): ToolCallContent[] {
	if (!result) return [];
	const blocks: ContentBlock[] = toAcpContentBlocks(result.content);
	return blocks.map((content) => ({ type: "content", content }));
}

export function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
