import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AdapterError, createTestClient, type TestClient } from "./harness.js";

/**
 * The ACP v2 draft, as served to a client whose `initialize` asks for it.
 *
 * Every test also runs under the conformance monitor, which checks each frame
 * against the v2 schema and v2's protocol rules (see conformance/monitor.ts).
 */

let client: TestClient;
let workspace: string;
let cleanup: () => void;

// v2 updates are not the harness's v1 types; tests read them loosely.
type AnyUpdate = Record<string, any> & { sessionUpdate: string };
const updates = (c: TestClient = client): AnyUpdate[] => c.updates as unknown as AnyUpdate[];
const ofKind = (kind: string, from: AnyUpdate[] = updates()) => from.filter((u) => u.sessionUpdate === kind);
const states = (from: AnyUpdate[] = updates()) =>
	ofKind("state_update", from).map((u) => (u.stopReason ? `${u.state}:${u.stopReason}` : u.state));

async function initialize(c: TestClient, capabilities: Record<string, unknown> = {}) {
	return c.request<any>("initialize", { protocolVersion: 2, info: { name: "test-client", version: "0" }, capabilities });
}

async function newSession(c: TestClient = client, dir: string = workspace): Promise<string> {
	const { sessionId } = await c.request<{ sessionId: string }>("session/new", { cwd: dir });
	return sessionId;
}

async function prompt(sessionId: string, text: string, c: TestClient = client): Promise<{ messageId: string }> {
	return c.request("session/prompt", { sessionId, prompt: [{ type: "text", text }] });
}

/** Wait until the session reports idle with a stop reason, i.e. a turn ended. */
async function turnEnded(count = 1, c: TestClient = client): Promise<void> {
	await c.waitFor(() => states(updates(c)).filter((s) => s.startsWith("idle:")).length >= count);
}

beforeEach(async () => {
	({ client, workspace, cleanup } = createTestClient());
	await initialize(client);
});

afterEach(() => cleanup());

describe("initialize", () => {
	it("negotiates the v2 draft and advertises what pi supports", async () => {
		const { client: fresh, cleanup: done } = createTestClient();
		try {
			const response = await initialize(fresh);
			expect(response).toEqual({
				protocolVersion: 2,
				info: { name: "pi-acp-minimal", title: "pi", version: expect.any(String) },
				capabilities: {
					session: { prompt: { image: {}, embeddedContext: {} }, mcp: { stdio: {}, http: {} }, delete: {} },
				},
			});
		} finally {
			done();
		}
	});

	it("still serves v1 to a client that asks for v1", async () => {
		const { client: old, cleanup: done } = createTestClient();
		try {
			const response = await old.request<any>("initialize", { protocolVersion: 1, clientCapabilities: {} });
			expect(response.protocolVersion).toBe(1);
			expect(response.agentCapabilities.loadSession).toBe(true);
		} finally {
			done();
		}
	});
});

describe("the prompt lifecycle", () => {
	it("answers with the user message's id, then reports the turn through state updates", async () => {
		const sessionId = await newSession();
		const seen: string[] = [];
		client.onUpdate = (u: any) => seen.push(u.sessionUpdate === "state_update" ? `state:${u.state}` : u.sessionUpdate);

		const { messageId } = await prompt(sessionId, "TEXT please");
		expect(ofKind("user_message")).toEqual([
			{ sessionUpdate: "user_message", messageId, content: [{ type: "text", text: "TEXT please" }] },
		]);
		expect(messageId).toMatch(/^u-\d+$/);

		await turnEnded();
		expect(states()).toEqual(["running", "idle:end_turn"]);
		// The echo, then `running`, then the turn's output.
		const order = ["user_message", "state:running", "agent_message_chunk", "state:idle"].map((kind) => seen.indexOf(kind));
		expect(order).toEqual([...order].sort((x, y) => x - y));
		const chunks = ofKind("agent_message_chunk");
		expect(chunks.map((u) => u.content.text).join("")).toBe("Hello, world!");
		expect(new Set(chunks.map((u) => u.messageId))).toEqual(new Set([expect.stringMatching(/^a-\d+:0$/)]));
		// Nothing of the turn comes after its idle.
		const idle = seen.lastIndexOf("state:idle");
		expect(seen.slice(idle + 1).filter((kind) => kind === "agent_message_chunk")).toEqual([]);
	});

	it("ends a failed turn with an error stop reason, not an error response", async () => {
		const sessionId = await newSession();
		const { messageId } = await prompt(sessionId, "ERROR please");
		expect(messageId).toBeTruthy();
		await turnEnded();
		expect(ofKind("state_update").at(-1)).toEqual({
			sessionUpdate: "state_update",
			state: "idle",
			stopReason: "error",
			error: { code: -32603, message: "Connection error." },
		});
	});

	it("reports a cancelled turn as idle with the cancelled stop reason", async () => {
		const sessionId = await newSession();
		await prompt(sessionId, "SLOW please");
		await client.waitFor(() => ofKind("agent_message_chunk").length > 0);
		client.cancel(sessionId);
		await turnEnded();
		expect(states()).toEqual(["running", "idle:cancelled"]);
	});

	it("answers a prompt pi handled without a run, and ends its turn", async () => {
		const sessionId = await newSession();
		const { messageId } = await prompt(sessionId, "NOOP please");
		expect(messageId).toMatch(/^u-/);
		await turnEnded();
		expect(states()).toEqual(["running", "idle:end_turn"]);
	});

	it("brackets a run nobody prompted for with running and idle", async () => {
		const sessionId = await newSession();
		await prompt(sessionId, "AUTORUN please");
		await turnEnded(2);
		expect(states()).toEqual(["running", "idle:end_turn", "running", "idle:end_turn"]);
		expect(client.agentText()).toContain("on my own");
	});

	it("rejects content types it does not support, without inserting anything", async () => {
		const sessionId = await newSession();
		const error = await client
			.request("session/prompt", { sessionId, prompt: [{ type: "audio", data: "AAAA", mimeType: "audio/wav" }] })
			.catch((e: unknown) => e);
		expect(error).toMatchObject({ code: -32602, data: { type: "audio" } });
		expect(ofKind("user_message")).toEqual([]);
		expect(ofKind("state_update")).toEqual([]);
	});

	it("names the session in the error for an unknown session", async () => {
		const error = await prompt("nope", "TEXT").catch((e: unknown) => e);
		expect(error).toBeInstanceOf(AdapterError);
		expect(error).toMatchObject({ code: -32002, data: { sessionId: "nope" } });
	});
});

describe("tool calls", () => {
	it("creates tool calls with tool_call_update and shows shell output in a terminal", async () => {
		const sessionId = await newSession();
		await prompt(sessionId, "BASH it");
		await turnEnded();

		expect(ofKind("tool_call")).toEqual([]);
		const terminal = updates().filter((u) => u.terminalId === "call-bash" && u.sessionUpdate.startsWith("terminal"));
		expect(terminal[0]).toEqual({ sessionUpdate: "terminal_update", terminalId: "call-bash", cwd: expect.any(String), command: "echo hi" });
		const output = ofKind("terminal_output_chunk", terminal).map((u) => Buffer.from(u.data, "base64").toString("utf8"));
		expect(output.join("")).toBe("hi\n");
		expect(terminal.at(-1)).toEqual({ sessionUpdate: "terminal_update", terminalId: "call-bash", exitStatus: { exitCode: 3 } });

		const calls = ofKind("tool_call_update").filter((u) => u.toolCallId === "call-bash");
		expect(calls[0]).toMatchObject({ title: "Run command", kind: "execute", status: "pending" });
		expect(calls.at(-1)).toMatchObject({ status: "completed", content: [{ type: "terminal", terminalId: "call-bash" }] });
	});

	it("sends an edit as a v2 diff with a git patch", async () => {
		const sessionId = await newSession();
		await prompt(sessionId, "EDIT it");
		await turnEnded();
		const last = ofKind("tool_call_update").filter((u) => u.toolCallId === "call-edit").at(-1)!;
		const file = path.join(workspace, "edited.txt");
		expect(last.content).toEqual([
			{
				type: "diff",
				changes: [{ operation: "modify", path: file, fileType: "text" }],
				patch: {
					format: "git_patch",
					text: [`diff --git ${file} ${file}`, `--- ${file}`, `+++ ${file}`, "@@ -1 +1 @@", "-before", "+after", ""].join("\n"),
				},
			},
		]);
	});
});

describe("dialogs", () => {
	it("asks for permission with a title and description, reporting requires_action meanwhile", async () => {
		client.permissionAnswer = "yes";
		const sessionId = await newSession();
		await prompt(sessionId, "CONFIRM please");
		await turnEnded();
		expect(client.permissionRequests).toEqual([
			{
				sessionId,
				title: "Run dangerous command?",
				description: "rm -rf /tmp/x",
				options: [
					{ optionId: "yes", name: "Yes", kind: "allow_once" },
					{ optionId: "no", name: "No", kind: "reject_once" },
				],
			},
		]);
		expect(states()).toEqual(["running", "requires_action", "running", "idle:end_turn"]);
		expect(client.agentText()).toBe("confirmed");
	});

	it("ties a prompt to the running tool call without renaming it", async () => {
		client.permissionAnswer = "yes";
		const sessionId = await newSession();
		await prompt(sessionId, "NESTED please");
		await turnEnded();
		expect((client.permissionRequests[0] as any).subject).toEqual({ type: "tool_call", toolCall: { toolCallId: "call-outer" } });
	});

	it("treats an option that was not offered as no approval", async () => {
		client.permissionAnswer = "maybe";
		const sessionId = await newSession();
		await prompt(sessionId, "CONFIRM please");
		await turnEnded();
		expect(client.agentText()).toBe("declined");
	});
});

describe("session/resume", () => {
	it("replays history under the ids it had live, then reports the state before answering", async () => {
		const sessionId = await newSession();
		const { messageId } = await prompt(sessionId, "THINK please");
		await turnEnded();
		const live = [...ofKind("agent_thought_chunk"), ...ofKind("agent_message_chunk")].map((u) => u.messageId);

		const before = updates().length;
		const response = await client.request<any>("session/resume", { sessionId, cwd: workspace, replayFrom: { type: "start" } });
		const replayed = updates().slice(before);

		// Whole messages, which replace the client's copy rather than append to it.
		expect(ofKind("user_message", replayed)).toEqual([
			{ sessionUpdate: "user_message", messageId, content: [{ type: "text", text: "THINK please" }] },
		]);
		expect(ofKind("agent_thought", replayed).map((u) => u.messageId)).toEqual([live[0]]);
		expect(ofKind("agent_message", replayed).map((u) => u.messageId)).toEqual([live[1]]);
		expect(ofKind("state_update", replayed)).toEqual([{ sessionUpdate: "state_update", state: "idle" }]);
		expect(response.configOptions[0]).toMatchObject({ configId: "model" });
	});

	it("resumes without a replay when none is asked for", async () => {
		const sessionId = await newSession();
		await prompt(sessionId, "TEXT please");
		await turnEnded();
		const before = updates().length;
		await client.request("session/resume", { sessionId, cwd: workspace });
		const after = updates().slice(before);
		expect(ofKind("user_message", after)).toEqual([]);
		expect(states(after)).toEqual(["idle"]);
	});

	it("rejects a replay cursor it does not support", async () => {
		const sessionId = await newSession();
		const error = await client
			.request("session/resume", { sessionId, cwd: workspace, replayFrom: { type: "message", messageId: "x" } })
			.catch((e: unknown) => e);
		expect(error).toMatchObject({ code: -32602 });
	});
});

describe("session/close", () => {
	it("ends a running turn as cancelled before answering, then goes quiet", async () => {
		const sessionId = await newSession();
		await prompt(sessionId, "SLOW please");
		await client.waitFor(() => ofKind("agent_message_chunk").length > 0);

		await client.request("session/close", { sessionId });
		expect(states().at(-1)).toBe("idle:cancelled");
		const count = updates().length;
		await new Promise((resolve) => setTimeout(resolve, 200));
		expect(updates().length).toBe(count);
	});

	it("succeeds for a session that is not open", async () => {
		await expect(client.request("session/close", { sessionId: "never-opened" })).resolves.toEqual({});
	});
});

describe("session setup", () => {
	it("renames config option fields and takes tagged values", async () => {
		const { sessionId, configOptions } = await client.request<any>("session/new", { cwd: workspace });
		const model = configOptions.find((o: any) => o.configId === "model");
		expect(model.options.map((g: any) => g.groupId)).toEqual(["anthropic", "openai"]);

		const set = await client.request<any>("session/set_config_option", { sessionId, configId: "model", type: "id", value: "openai/gpt-5" });
		expect(set.configOptions.find((o: any) => o.configId === "model").currentValue).toBe("openai/gpt-5");
		const error = await client
			.request("session/set_config_option", { sessionId, configId: "model", type: "boolean", value: true })
			.catch((e: unknown) => e);
		expect(error).toMatchObject({ code: -32602 });
	});

	it("tags commands and sends notices without a capability for them", async () => {
		const sessionId = await newSession();
		await client.waitFor(() => ofKind("available_commands_update").length > 0);
		expect(ofKind("available_commands_update")[0]!.availableCommands[0]).toMatchObject({
			type: "command",
			input: { type: "text", hint: "arguments" },
		});
		await prompt(sessionId, "RETRY please");
		await turnEnded();
		expect(ofKind("notice").length).toBeGreaterThan(0);
	});

	it("rejects an MCP transport pi cannot speak", async () => {
		const error = await client
			.request("session/new", { cwd: workspace, mcpServers: [{ type: "sse", name: "old", url: "https://x", headers: [] }] })
			.catch((e: unknown) => e);
		expect(error).toMatchObject({ code: -32602 });
	});
});
