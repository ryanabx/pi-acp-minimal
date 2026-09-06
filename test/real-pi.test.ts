import { describe, expect, it } from "vitest";
import { PROTOCOL_VERSION } from "@agentclientprotocol/sdk";
import { createTestClient } from "./harness.js";

/**
 * Smoke tests against a real `pi` install.
 *
 * Opt in with `PI_ACP_REAL_PI=1 npm test`. These exercise only paths that do not
 * need a reachable model provider, so they stay deterministic on any machine
 * that has pi on its PATH.
 */
const enabled = process.env.PI_ACP_REAL_PI === "1";
const piCommand = process.env.PI_ACP_PI_COMMAND ?? "pi";

describe.skipIf(!enabled)("real pi", () => {
	it("completes the ACP handshake and reports pi's real configuration", async () => {
		const { client, workspace, cleanup } = createTestClient({ piCommand });
		try {
			const init = await client.initialize({
				protocolVersion: PROTOCOL_VERSION,
				clientCapabilities: { fs: { readTextFile: true, writeTextFile: false } },
			});
			expect(init.agentCapabilities?.loadSession).toBe(true);

			const session = await client.newSession({
				cwd: workspace,
				mcpServers: [],
			});
			// The ACP session id is pi's own session file, so `session/load` can resume it.
			expect(session.sessionId).toMatch(/\.jsonl$/);
			const model = (session.configOptions ?? []).find((option) => option.id === "model");
			if (!model || model.type !== "select") throw new Error("no model config option");
			expect(model.currentValue).toContain("/");
			expect(model.options.length).toBeGreaterThan(0);

			await client.waitFor((updates) => updates.some((u) => u.sessionUpdate === "available_commands_update"));
		} finally {
			cleanup();
		}
	}, 60_000);

	it("cancels an in-flight prompt", async () => {
		const { client, workspace, cleanup } = createTestClient({ piCommand });
		try {
			await client.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} });
			const { sessionId } = await client.newSession({ cwd: workspace, mcpServers: [] });

			const pending = client.prompt({ sessionId, prompt: [{ type: "text", text: "Count to a million." }] });
			await new Promise((resolve) => setTimeout(resolve, 500));
			client.cancel(sessionId);
			await expect(pending).resolves.toEqual({ stopReason: "cancelled" });
		} finally {
			cleanup();
		}
	}, 60_000);
});
