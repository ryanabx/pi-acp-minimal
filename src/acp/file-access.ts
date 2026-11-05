import { readFile } from "node:fs/promises";
import type { ClientPort } from "./client-port.js";

/**
 * Reads text files on behalf of the adapter, preferring the client's file
 * system so unsaved editor buffers are reflected in diffs.
 *
 * Falls back to the local file system when the client does not advertise
 * `fs.readTextFile` — pi and the adapter always run on the same machine.
 */
export class FileAccess {
	constructor(
		private readonly client: ClientPort,
		/** Read lazily: `session/load` can rename the session after construction. */
		private readonly sessionId: () => string,
	) {}

	/** File contents, or `null` when the file does not exist or cannot be read. */
	async readText(absolutePath: string): Promise<string | null> {
		if (this.client.capabilities?.fs?.readTextFile) {
			try {
				return await this.client.readTextFile(this.sessionId(), absolutePath);
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
