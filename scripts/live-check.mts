/**
 * Manual end-to-end check against a real pi install and a real model.
 *
 * Not part of `npm test`: it needs a reachable provider and a live model, and
 * model output is not deterministic enough to assert on. Run it by hand to
 * verify the adapter against reality:
 *
 *   LIVE_MODEL=llama.cpp/Qwen3.8-27B-Fast npx tsx scripts/live-check.mts
 *
 * Every `session/update` is logged synchronously, so the log order is the wire
 * order — which is what makes it useful for checking that content reaches the
 * client before `session/prompt` resolves.
 */
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { PROTOCOL_VERSION } from "@agentclientprotocol/sdk";
import { TestClient } from "../test/harness.js";

const MODEL = process.env.LIVE_MODEL ?? "llama.cpp/Qwen3.8-27B-Fast";
const workspace = mkdtempSync(path.join(tmpdir(), "pi-acp-minimal-live-"));
writeFileSync(path.join(workspace, "hello.txt"), "hello world\n");

const client = new TestClient({
	workspace,
	piCommand: "pi",
	extraArgs: ["--model", MODEL, "--session-dir", path.join(workspace, "sessions")],
});

const t0 = Date.now();
const stamp = () => `${((Date.now() - t0) / 1000).toFixed(3).padStart(7)}s`;
const say = (line: string) => console.log(`${stamp()}  ${line}`);

// Synchronous, so the log order is the wire order.
client.onUpdate = (u: any) => {
	switch (u.sessionUpdate) {
		case "agent_message_chunk":
			return say(`TEXT   ${JSON.stringify(u.content.text)}`);
		case "agent_thought_chunk":
			return say(`THINK  <${u.content.text.length} chars>`);
		case "user_message_chunk":
			return say(`USER   ${JSON.stringify(u.content.text).slice(0, 120)}`);
		case "tool_call":
			return say(`TOOL+  ${u.toolCallId.slice(0, 8)} kind=${u.kind} status=${u.status} title=${JSON.stringify(u.title)}`);
		case "tool_call_update": {
			const bits = [`TOOL~  ${u.toolCallId.slice(0, 8)}`];
			if (u.status) bits.push(`status=${u.status}`);
			if (u.title) bits.push(`title=${JSON.stringify(u.title)}`);
			if (u.locations?.length) bits.push(`loc=${u.locations.map((l: any) => l.path).join(",")}`);
			if (u.content) bits.push(`content=${JSON.stringify(u.content).slice(0, 220)}`);
			if (u.rawOutput) bits.push(`out=${JSON.stringify(u.rawOutput).slice(0, 120)}`);
			return say(bits.join(" "));
		}
		case "available_commands_update":
			return say(`CMDS   ${u.availableCommands.map((c: any) => c.name).join(", ")}`);
		case "current_mode_update":
			return say(`MODE   ${u.currentModeId}`);
		default:
			return say(`?      ${JSON.stringify(u).slice(0, 160)}`);
	}
};

try {
	await client.initialize({
		protocolVersion: PROTOCOL_VERSION,
		clientCapabilities: { fs: { readTextFile: true, writeTextFile: false }, terminal: false },
	});
	const session = await client.newSession({ cwd: workspace, mcpServers: [] });
	say(`SESSION ${session.sessionId}`);
	const modelOption = (session.configOptions ?? []).find((o: any) => o.id === "model") as any;
	say(`MODEL   ${modelOption?.currentValue} (${modelOption?.options?.length ?? 0} entries)`);

	// ---- turn 1: tools -----------------------------------------------------
	say("=== turn 1 ===");
	const r1 = await client.prompt({
		sessionId: session.sessionId,
		prompt: [
			{
				type: "text",
				text:
					"Do exactly these steps with your tools: 1) read hello.txt. " +
					"2) write shout.txt containing the uppercase text. Then reply with only the word DONE.",
			},
		],
	});
	say(`STOP    ${JSON.stringify(r1)}`);
	const shout = path.join(workspace, "shout.txt");
	say(`SHOUT   ${existsSync(shout) ? JSON.stringify(readFileSync(shout, "utf8")) : "<missing>"}`);

	// ---- turn 2: same session, second prompt -------------------------------
	say("=== turn 2 (same session) ===");
	const r2 = await client.prompt({
		sessionId: session.sessionId,
		prompt: [{ type: "text", text: "Reply with only the word SECOND. Do not use any tools." }],
	});
	say(`STOP    ${JSON.stringify(r2)}`);

	// ---- turn 3: cancel mid-flight -----------------------------------------
	say("=== turn 3 (cancel) ===");
	const pending = client.prompt({
		sessionId: session.sessionId,
		prompt: [{ type: "text", text: "Count slowly from 1 to 500, one number per line." }],
	});
	await new Promise((r) => setTimeout(r, 3000));
	say("CANCEL  sending session/cancel");
	client.cancel(session.sessionId);
	say(`STOP    ${JSON.stringify(await pending)}`);

	// ---- model switch (no prompt, so no second model loads) -----------------
	say("=== set_config_option ===");
	const switched = await client.setConfigOption(session.sessionId, "model", "llama.cpp/Qwen3.8-27B-Large");
	say(`MODEL   ${JSON.stringify((switched.configOptions as any[]).find((o) => o.id === "model")?.currentValue)} (not loaded: no prompt sent)`);
	await client.setConfigOption(session.sessionId, "model", MODEL);

	// ---- session/load replay -----------------------------------------------
	say("=== session/load ===");
	const before = client.updates.length;
	const loaded = await client.loadSession({ sessionId: session.sessionId, cwd: workspace, mcpServers: [] });
	const loadedModel = (loaded.configOptions ?? []).find((o: any) => o.id === "model") as any;
	say(`LOADED  model=${loadedModel?.currentValue} replayed=${client.updates.length - before} updates`);
} catch (error) {
	say(`ERROR   ${error instanceof Error ? error.stack : String(error)}`);
} finally {
	console.log("\nSTDERR:\n" + client.stderr.join("").slice(-2500));
	client.close();
	console.log("WORKSPACE " + workspace);
}
process.exit(0);
