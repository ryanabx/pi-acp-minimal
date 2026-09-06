import { readFile } from "node:fs/promises";
import type { AgentSideConnection, ClientCapabilities } from "@agentclientprotocol/sdk";

/**
 * Reads text files on behalf of the adapter, preferring the client's file
 * system so unsaved editor buffers are reflected in diffs.
 *
 * Falls back to the local file system when the client does not advertise
 * `fs.readTextFile` — pi and the adapter always run on the same machine.
 */
export class FileAccess {
	constructor(
		private readonly connection: AgentSideConnection,
		private readonly capabilities: ClientCapabilities | undefined,
		/** Read lazily: `session/load` can rename the session after construction. */
		private readonly sessionId: () => string,
	) {}

	/** File contents, or `null` when the file does not exist or cannot be read. */
	async readText(absolutePath: string): Promise<string | null> {
		if (this.capabilities?.fs?.readTextFile) {
			try {
				const response = await this.connection.readTextFile({ sessionId: this.sessionId(), path: absolutePath });
				return response.content;
			} catch {
				// Client refused or does not know the file; fall through to local disk.
			}
		}
		try {
			return await readFile(absolutePath, "utf8");
		} catch {
			return null;
		}
	}
}
