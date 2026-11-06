import { internalError } from "./errors.js";

/**
 * The object that serves an agent app's one connection: created when the
 * connection opens, shut down when it closes.
 *
 * Over stdio there is exactly one connection. A server that accepts several
 * should build one app per connection: the app owns that connection's
 * sessions.
 */
export class ConnectionSlot<T extends { shutdown(): Promise<void> }> {
	#current: T | undefined;

	/** Call from the app's `onConnect`, which runs before the connection handles its first message. */
	open(connection: { closed: Promise<unknown> }, create: () => T): void {
		if (this.#current) throw new Error("An agent app serves a single connection; build one app per connection");
		const current = create();
		this.#current = current;
		void connection.closed.then(() => current.shutdown());
	}

	get(): T {
		if (!this.#current) throw internalError("ACP connection is not set up");
		return this.#current;
	}

	async shutdown(): Promise<void> {
		await this.#current?.shutdown();
	}
}
