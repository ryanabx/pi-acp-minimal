/**
 * ACP message ids for pi's messages.
 *
 * ACP v2 requires an id on every message chunk and, when a session is
 * replayed, the id the message had live. pi gives its messages no id, but
 * every message it stores carries the timestamp it had when it streamed, so
 * ids derive from that: a live message and its replay get the same id.
 *
 * Each ACP message type has its own id space. An assistant message becomes
 * one ACP message per content part (`a-<ts>:<index>`), which keeps text,
 * thinking and tool calls in the order pi produced them.
 */
export class MessageIds {
	#fallbacks = 0;

	/** The user message pi stored for a prompt, or one it replays. */
	user(message: { timestamp?: number }): string {
		return `u-${this.#stamp(message)}`;
	}

	/** A shell command the user ran with `!`, shown as a user message. */
	bashExecution(message: { timestamp?: number }): string {
		return `u-bash-${this.#stamp(message)}`;
	}

	/** An extension message pi displays, shown as a user message. */
	custom(message: { timestamp?: number }): string {
		return `u-custom-${this.#stamp(message)}`;
	}

	/** A prompt pi took without storing a user message, such as one an extension command handled. */
	unstoredPrompt(): string {
		return `u-prompt-${++this.#fallbacks}`;
	}

	/** The base id of an assistant message; see {@link assistantPart}. */
	assistant(message: { timestamp?: number }): string {
		return `a-${this.#stamp(message)}`;
	}

	/** Text the adapter adds to the transcript itself, such as a status line. */
	adapterNote(): string {
		return `a-note-${++this.#fallbacks}`;
	}

	#stamp(message: { timestamp?: number }): string {
		return typeof message.timestamp === "number" ? String(message.timestamp) : `n${++this.#fallbacks}`;
	}
}

/** One content part of an assistant message, by its index in pi's content array. */
export function assistantPart(base: string, index: number | "error"): string {
	return `${base}:${index}`;
}
