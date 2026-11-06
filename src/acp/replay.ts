import { toAcpContentBlocks } from "../map/content.js";
import { assistantPart, type MessageIds } from "../map/message-ids.js";
import type { PiMessage } from "../pi/rpc-types.js";
import type { SessionUpdate } from "./client-port.js";
import type { ToolCalls } from "./tool-calls.js";

/** What {@link replayMessage} needs from the session it replays into. */
export interface ReplaySession {
	readonly ids: MessageIds;
	readonly toolCalls: ToolCalls;
	notify(update: SessionUpdate): Promise<void>;
	/** Mark where a stored compaction happened, if the client tracks compactions. */
	compactionSummary(summary: string): Promise<void>;
}

/**
 * Re-emit one stored pi message as `session/update` notifications, for
 * `session/load` (v1) or a `session/resume` that replays (v2). Each message
 * gets the id it had live (see `MessageIds`).
 */
export async function replayMessage(session: ReplaySession, message: PiMessage): Promise<void> {
	const { ids, notify } = session;
	switch (message.role) {
		case "user": {
			const messageId = ids.user(message);
			for (const content of toAcpContentBlocks(message.content)) {
				await notify({ sessionUpdate: "user_message_chunk", messageId, content });
			}
			return;
		}
		case "assistant": {
			const base = ids.assistant(message);
			for (const [index, part] of message.content.entries()) {
				if (part.type === "text") {
					if (part.text) {
						await notify({
							sessionUpdate: "agent_message_chunk",
							messageId: assistantPart(base, index),
							content: { type: "text", text: part.text },
						});
					}
				} else if (part.type === "thinking") {
					if (part.thinking) {
						await notify({
							sessionUpdate: "agent_thought_chunk",
							messageId: assistantPart(base, index),
							content: { type: "text", text: part.thinking },
						});
					}
				} else {
					await session.toolCalls.replayCall(part.id, part.name, part.arguments ?? {});
				}
			}
			if (message.stopReason === "error" && message.errorMessage) {
				await notify({
					sessionUpdate: "agent_message_chunk",
					messageId: assistantPart(base, "error"),
					content: { type: "text", text: `\n_pi error: ${message.errorMessage}_\n` },
				});
			}
			return;
		}
		case "toolResult":
			return session.toolCalls.replayResult(message);

		case "bashExecution": {
			const text = ["Ran `" + message.command + "`", "```", message.output, "```"].join("\n");
			await notify({
				sessionUpdate: "user_message_chunk",
				messageId: ids.bashExecution(message),
				content: { type: "text", text },
			});
			return;
		}

		case "custom": {
			// Extension context message. pi shows these only when `display` is
			// true and converts them to a user message for the model.
			if (!message.display) return;
			const messageId = ids.custom(message);
			for (const content of toAcpContentBlocks(message.content)) {
				await notify({ sessionUpdate: "user_message_chunk", messageId, content });
			}
			return;
		}

		case "compactionSummary":
			// A client that tracks compactions shows where one happened; for
			// anyone else the summary is model context, not transcript.
			return session.compactionSummary(message.summary);

		default:
			// system and branchSummary are model context, not transcript: pi
			// sends them in get_messages but they are not part of the
			// conversation a client wants reloaded.
			return;
	}
}
