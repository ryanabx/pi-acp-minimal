/**
 * pi extension loaded by pi-acp-minimal (with `-e`) when an ACP client
 * supplies MCP servers in `session/new`, `session/load` or `session/resume`.
 *
 * pi has no command-line flag or RPC command for adding MCP servers, but
 * extensions can register them for the current session. The adapter passes the
 * servers, already converted to pi's `mcpServers` format, in an environment
 * variable. The variable is removed as soon as it is read, so the commands
 * pi's tools run never see it: header and env values can carry credentials.
 *
 * Plain JavaScript, so pi can load it without a build step.
 */
const VARIABLE = "PI_ACP_MCP_SERVERS";

/** @param {{ registerMcpServer?: (name: string, config: unknown) => void }} pi */
export default function acpMcpServers(pi) {
	const raw = process.env[VARIABLE];
	delete process.env[VARIABLE];
	if (!raw) return;

	let servers;
	try {
		servers = JSON.parse(raw);
	} catch (error) {
		console.error(`[pi-acp-minimal] ignoring unreadable ${VARIABLE}: ${error instanceof Error ? error.message : error}`);
		return;
	}

	if (typeof pi.registerMcpServer !== "function") {
		console.error("[pi-acp-minimal] this pi cannot register MCP servers from extensions; ignoring the client's servers");
		return;
	}

	for (const [name, config] of Object.entries(servers ?? {})) {
		try {
			pi.registerMcpServer(name, config);
		} catch (error) {
			console.error(`[pi-acp-minimal] could not register MCP server "${name}": ${error instanceof Error ? error.message : error}`);
		}
	}
}
