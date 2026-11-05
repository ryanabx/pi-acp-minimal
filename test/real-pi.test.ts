import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
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
/** Keep pi's session files in the temporary workspace rather than in ~/.pi. */
const ownSessionDir = (workspace: string) => ["--session-dir", path.join(workspace, "sessions")];

describe.skipIf(!enabled)("real pi", () => {
	it("completes the ACP handshake and reports pi's real configuration", async () => {
		const { client, workspace, cleanup } = createTestClient({ piCommand, extraArgs: ownSessionDir });
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
		const { client, workspace, cleanup } = createTestClient({ piCommand, extraArgs: ownSessionDir });
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

	it("lists, resumes, closes and deletes pi's stored sessions", async () => {
		// A `trash` that only deletes, so nothing lands in the machine's real trash.
		const bin = fakeTrashBin();
		const { client, workspace, cleanup } = createTestClient({
			piCommand,
			extraArgs: ownSessionDir,
			env: { PATH: `${bin}${path.delimiter}${process.env.PATH ?? ""}` },
		});
		try {
			await client.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} });
			const { sessionId } = await client.newSession({ cwd: workspace, mcpServers: [] });
			// pi writes the session file once the conversation has a message.
			const pending = client.prompt({ sessionId, prompt: [{ type: "text", text: "Count to a million." }] });
			await new Promise((resolve) => setTimeout(resolve, 500));
			client.cancel(sessionId);
			await pending;

			const listed = await client.request<{ sessions: Array<{ sessionId: string; title?: string }> }>("session/list", {
				cwd: workspace,
			});
			expect(listed.sessions.map((session) => session.sessionId)).toEqual([sessionId]);
			expect(listed.sessions[0]?.title).toBe("Count to a million.");

			const resumed = await client.request<{ configOptions: unknown[] }>("session/resume", {
				sessionId,
				cwd: workspace,
				mcpServers: [],
			});
			expect(resumed.configOptions.length).toBeGreaterThan(0);

			await client.request("session/close", { sessionId });
			await client.request("session/delete", { sessionId });
			expect(existsSync(sessionId)).toBe(false);
			expect((await client.request<{ sessions: unknown[] }>("session/list", { cwd: workspace })).sessions).toEqual([]);
		} finally {
			cleanup();
			rmSync(bin, { recursive: true, force: true });
		}
	}, 60_000);
});

function fakeTrashBin(): string {
	const bin = mkdtempSync(path.join(tmpdir(), "pi-acp-fake-trash-"));
	writeFileSync(path.join(bin, "trash"), '#!/bin/sh\nrm -- "$1"\n');
	chmodSync(path.join(bin, "trash"), 0o755);
	return bin;
}
