import type { McpServer } from "@agentclientprotocol/sdk";

/** One `mcpServers` entry in pi's format (`docs/mcp.md`). */
export type PiMcpServerConfig =
	| { command: string; args: string[]; env?: Record<string, string> }
	| { url: string; headers?: Record<string, string> };

/**
 * ACP `McpServer`s -> pi MCP server configs, keyed by pi server name.
 *
 * - pi has no legacy SSE transport, so SSE servers are dropped (the adapter
 *   does not advertise `mcpCapabilities.sse`, so clients should not send them).
 * - pi server names allow only letters, digits, `_` and `-`, and treat names
 *   that differ only in `-` and `_` as the same server, so names are
 *   sanitised and made unique.
 * - pi expands `${VAR}`/`$VAR` and runs `!command` in `env` values and
 *   `headers`; ACP values are literal, so they are escaped.
 */
export function toPiMcpServers(
	servers: readonly McpServer[],
	warn: (message: string) => void,
): Record<string, PiMcpServerConfig> {
	const result: Record<string, PiMcpServerConfig> = {};
	const taken = new Set<string>();

	for (const server of servers) {
		if ("type" in server && server.type === "sse") {
			warn(`skipping MCP server "${server.name}": pi does not support the SSE transport`);
			continue;
		}

		const name = uniqueName(server.name, taken);
		if ("type" in server && server.type === "http") {
			result[name] = {
				url: server.url,
				...(server.headers.length > 0 ? { headers: literalRecord(server.headers) } : {}),
			};
		} else if ("command" in server) {
			result[name] = {
				command: server.command,
				args: [...server.args],
				...(server.env.length > 0 ? { env: literalRecord(server.env) } : {}),
			};
		}
	}
	return result;
}

/**
 * Escape a value so pi's config-value resolution yields it unchanged:
 * `$$` is a literal `$`, and `$!` keeps a leading `!` from meaning "run this".
 */
export function literalConfigValue(value: string): string {
	const escaped = value.replaceAll("$", "$$$$");
	return escaped.startsWith("!") ? `$${escaped}` : escaped;
}

function literalRecord(entries: ReadonlyArray<{ name: string; value: string }>): Record<string, string> {
	return Object.fromEntries(entries.map(({ name, value }) => [name, literalConfigValue(value)]));
}

function uniqueName(name: string, taken: Set<string>): string {
	const base = name.replace(/[^A-Za-z0-9_-]+/g, "_").replace(/^_+|_+$/g, "") || "server";
	let candidate = base;
	for (let n = 2; taken.has(sameServerKey(candidate)); n++) candidate = `${base}_${n}`;
	taken.add(sameServerKey(candidate));
	return candidate;
}

/** pi treats server names that differ only in `-` and `_` as one server. */
function sameServerKey(name: string): string {
	return name.replaceAll("-", "_");
}
