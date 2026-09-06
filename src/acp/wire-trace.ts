import { appendFileSync } from "node:fs";
import type { Stream } from "@agentclientprotocol/sdk";

/**
 * Mirror every ACP frame to a JSONL file.
 *
 * Diagnosing a client-side rendering problem means knowing exactly what crossed
 * the wire in both directions, which stderr logging cannot show. Tracing never
 * throws: a broken trace file must not take the session down with it.
 */
export function traceStream(stream: Stream, filePath: string): Stream {
	const record = (direction: "in" | "out", message: unknown) => {
		try {
			appendFileSync(filePath, `${JSON.stringify({ t: new Date().toISOString(), direction, message })}\n`);
		} catch {
			// Tracing is best-effort.
		}
	};

	const readable = stream.readable.pipeThrough(
		new TransformStream({
			transform(message, controller) {
				record("in", message);
				controller.enqueue(message);
			},
		}),
	);

	const writable = new WritableStream({
		async write(message) {
			record("out", message);
			const writer = stream.writable.getWriter();
			try {
				await writer.write(message);
			} finally {
				writer.releaseLock();
			}
		},
		async close() {
			await stream.writable.close();
		},
		async abort(reason) {
			await stream.writable.abort(reason);
		},
	});

	return { readable, writable };
}
