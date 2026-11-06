/**
 * Pure conversions between the core's ACP v1 shapes and ACP v2.
 *
 * Where v1 and v2 agree field for field, values pass through with a cast:
 * v2's types differ there only in being open to variants a newer ACP adds.
 */
import type * as v1 from "@agentclientprotocol/sdk";
import type * as v2 from "@agentclientprotocol/sdk/experimental/v2";
import { gitPatch } from "../../map/git-patch.js";

// ============================================================================
// Session setup
// ============================================================================

/** v1 `id`/`group` become v2 `configId`/`groupId`; everything else carries over. */
export function toV2ConfigOptions(options: v1.SessionConfigOption[]): v2.SessionConfigOption[] {
	return options.map((option) => {
		const { id, ...rest } = option;
		if (rest.type !== "select") return { ...rest, configId: id } as v2.SessionConfigOption;
		const choices = rest.options.map((choice) => {
			if (!("group" in choice)) return choice;
			const { group, ...groupRest } = choice;
			return { ...groupRest, groupId: group };
		});
		return { ...rest, configId: id, options: choices } as v2.SessionConfigOption;
	});
}

/**
 * v2 commands are tagged, and so is their input. Names MUST be unique and
 * contain no whitespace, so any that would break that are left out.
 */
export function toV2Commands(commands: v1.AvailableCommand[]): v2.AvailableCommand[] {
	const seen = new Set<string>();
	const result: v2.AvailableCommand[] = [];
	for (const command of commands) {
		if (/\s/.test(command.name) || seen.has(command.name)) continue;
		seen.add(command.name);
		const { input, ...rest } = command;
		result.push({
			...rest,
			type: "command",
			...(input && "hint" in input ? { input: { type: "text", hint: input.hint } } : {}),
		} as v2.AvailableCommand);
	}
	return result;
}

/**
 * v2 MCP servers are tagged by transport, and their lists are optional. Only
 * stdio and http reach here: the caller rejects other transports first.
 */
export function toV1McpServers(servers: v2.McpServer[] | null | undefined): v1.McpServer[] {
	return (servers ?? []).flatMap((server): v1.McpServer[] => {
		if (server.type === "stdio") {
			const { type: _type, ...rest } = server as Extract<v2.McpServer, { type: "stdio" }>;
			return [{ ...rest, args: rest.args ?? [], env: rest.env ?? [] } as v1.McpServer];
		}
		if (server.type === "http") {
			const http = server as Extract<v2.McpServer, { type: "http" }>;
			return [{ ...http, type: "http", headers: http.headers ?? [] } as v1.McpServer];
		}
		return [];
	});
}

/** Prompt content types this agent takes in a v2 `session/prompt`. */
const PROMPT_CONTENT_TYPES = new Set(["text", "image", "resource", "resource_link"]);

/** The first prompt block of a type this agent does not support, if any. */
export function unsupportedPromptContent(prompt: v2.ContentBlock[]): string | undefined {
	return prompt.find((block) => !PROMPT_CONTENT_TYPES.has(block.type))?.type;
}

// ============================================================================
// Tool calls
// ============================================================================

/** Tool call content: a v1 diff (old and new text) becomes a v2 diff (changes plus a git patch). */
export function toV2ToolCallContent(content: v1.ToolCallContent[]): v2.ToolCallContent[] {
	return content.map((item): v2.ToolCallContent => {
		if (item.type !== "diff") return item as v2.ToolCallContent;
		const oldText = item.oldText ?? null;
		const patch = gitPatch(item.path, oldText, item.newText);
		const change: v2.DiffChange =
			oldText === null
				? { operation: "add", path: item.path, fileType: "text" }
				: { operation: "modify", path: item.path, fileType: "text" };
		return {
			type: "diff",
			changes: [change],
			...(patch ? { patch: { format: "git_patch" as const, text: patch } } : {}),
		};
	});
}

/** v2 lines are 1-based; a v1 location may carry 0. */
export function toV2Locations(locations: v1.ToolCallLocation[]): v2.ToolCallLocation[] {
	return locations.map(({ line, ...rest }) => ({
		...rest,
		...(typeof line === "number" && line >= 1 ? { line } : {}),
	}));
}
