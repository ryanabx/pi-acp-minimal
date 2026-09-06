import type { AvailableCommand } from "@agentclientprotocol/sdk";
import type { PiSlashCommand } from "../pi/rpc-types.js";

const SOURCE_LABELS: Record<PiSlashCommand["source"], string> = {
	extension: "extension",
	prompt: "prompt template",
	skill: "skill",
};

/**
 * pi slash command -> ACP available command.
 *
 * ACP clients send the selected command back as plain `/name args` text in the
 * next prompt, which is exactly what pi's `prompt` command already expands.
 */
export function toAcpCommand(command: PiSlashCommand): AvailableCommand {
	const scope = command.sourceInfo?.scope ?? command.location;
	const origin = scope && scope !== "temporary" ? `${SOURCE_LABELS[command.source]}, ${scope}` : SOURCE_LABELS[command.source];

	return {
		name: command.name,
		description: command.description ? `${command.description} (${origin})` : origin,
		input: { hint: "arguments" },
	};
}
