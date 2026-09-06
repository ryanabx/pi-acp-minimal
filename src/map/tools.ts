import path from "node:path";
import type { ToolCallLocation, ToolKind } from "@agentclientprotocol/sdk";

/** pi's built-in tool names, which get richer ACP treatment than extension tools. */
export const PI_BUILTIN_TOOLS = ["bash", "powershell", "edit", "write", "read", "ls", "grep", "find"] as const;

const TOOL_KINDS: Record<string, ToolKind> = {
	bash: "execute",
	powershell: "execute",
	edit: "edit",
	write: "edit",
	read: "read",
	ls: "read",
	grep: "search",
	find: "search",
};

/** Tools whose effect on disk is worth rendering as an ACP diff. */
export function isFileMutatingTool(toolName: string): boolean {
	return toolName === "edit" || toolName === "write";
}

export function toolKind(toolName: string): ToolKind {
	const kind = TOOL_KINDS[toolName];
	if (kind) return kind;
	// Extension tools follow no fixed naming scheme, so fall back to weak name hints.
	const lower = toolName.toLowerCase();
	if (/(^|_)(read|cat|view|open)($|_)/.test(lower)) return "read";
	if (/(^|_)(search|grep|find|glob)($|_)/.test(lower)) return "search";
	if (/(^|_)(edit|write|patch|apply)($|_)/.test(lower)) return "edit";
	if (/(^|_)(delete|rm|remove)($|_)/.test(lower)) return "delete";
	if (/(^|_)(move|mv|rename)($|_)/.test(lower)) return "move";
	if (/(^|_)(bash|shell|exec|run|command)($|_)/.test(lower)) return "execute";
	if (/(^|_)(fetch|http|curl|web)($|_)/.test(lower)) return "fetch";
	return "other";
}

function str(args: Record<string, unknown> | undefined, key: string): string | undefined {
	const value = args?.[key];
	return typeof value === "string" ? value : undefined;
}

function num(args: Record<string, unknown> | undefined, key: string): number | undefined {
	const value = args?.[key];
	return typeof value === "number" ? value : undefined;
}

/** Absolute path for a tool argument, resolved against the session cwd. */
export function resolvePath(cwd: string, value: string): string {
	return path.isAbsolute(value) ? value : path.resolve(cwd, value);
}

/** Path shown in tool titles: relative to cwd when inside it, absolute otherwise. */
export function displayPath(cwd: string, value: string): string {
	const absolute = resolvePath(cwd, value);
	const relative = path.relative(cwd, absolute);
	return relative && !relative.startsWith("..") ? relative : absolute;
}

/** The single file path a tool call operates on, if it has one. */
export function toolFilePath(toolName: string, args: Record<string, unknown> | undefined): string | undefined {
	switch (toolName) {
		case "read":
		case "write":
		case "edit":
		case "ls":
			return str(args, "path");
		case "grep":
		case "find":
			return str(args, "path");
		default:
			return str(args, "path") ?? str(args, "file_path") ?? str(args, "filePath");
	}
}

export function toolLocations(
	cwd: string,
	toolName: string,
	args: Record<string, unknown> | undefined,
	line?: number,
): ToolCallLocation[] {
	const filePath = toolFilePath(toolName, args);
	if (!filePath) return [];
	const location: ToolCallLocation = { path: resolvePath(cwd, filePath) };
	const resolvedLine = line ?? (toolName === "read" ? num(args, "offset") : undefined);
	if (resolvedLine !== undefined) location.line = resolvedLine;
	return [location];
}

function firstLine(value: string, limit = 120): string {
	const line = value.split("\n", 1)[0] ?? "";
	const collapsed = line.trim();
	const suffix = collapsed.length < value.trim().length ? " …" : "";
	return (collapsed.length > limit ? `${collapsed.slice(0, limit)}…` : collapsed) + suffix;
}

/**
 * Human-readable ACP tool call title.
 *
 * Called both before arguments have streamed in (`args` undefined) and again
 * once they are complete, so every branch must degrade to the bare tool name.
 */
export function toolTitle(cwd: string, toolName: string, args?: Record<string, unknown>): string {
	const file = toolFilePath(toolName, args);
	const shown = file ? displayPath(cwd, file) : undefined;

	switch (toolName) {
		case "read": {
			const offset = num(args, "offset");
			const limit = num(args, "limit");
			if (!shown) return "Read";
			if (offset !== undefined && limit !== undefined) return `Read ${shown}:${offset}-${offset + limit - 1}`;
			if (offset !== undefined) return `Read ${shown}:${offset}`;
			return `Read ${shown}`;
		}
		case "write":
			return shown ? `Write ${shown}` : "Write";
		case "edit": {
			if (!shown) return "Edit";
			const edits = args?.edits;
			const count = Array.isArray(edits) ? edits.length : 0;
			return count > 1 ? `Edit ${shown} (${count} edits)` : `Edit ${shown}`;
		}
		case "ls":
			return shown ? `List ${shown}` : "List directory";
		case "grep": {
			const pattern = str(args, "pattern");
			if (!pattern) return "Search";
			const glob = str(args, "glob");
			const scope = glob ?? shown;
			return scope ? `Search "${pattern}" in ${scope}` : `Search "${pattern}"`;
		}
		case "find": {
			const pattern = str(args, "pattern");
			if (!pattern) return "Find files";
			return shown ? `Find "${pattern}" in ${shown}` : `Find "${pattern}"`;
		}
		case "bash":
		case "powershell": {
			const command = str(args, "command");
			return command ? firstLine(command) : toolName === "bash" ? "Run command" : "Run PowerShell command";
		}
		default:
			return shown ? `${toolName} ${shown}` : toolName;
	}
}
