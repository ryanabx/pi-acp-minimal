import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { PROTOCOL_VERSION } from "@agentclientprotocol/sdk";
import { ConformanceMonitor } from "./conformance/monitor.js";
import { createTestClient, type TestClient } from "./harness.js";

/**
 * ACP conformance, for v1 and for the v2 draft.
 *
 * Every test in the suite already runs under the conformance monitor (see
 * conformance/setup.ts). This file adds two things: proof that the monitor
 * catches each kind of violation, so a broken checker cannot pass everything
 * silently, and a sweep that drives every mock scenario and session method
 * for a client that advertises nothing and one that advertises everything.
 */

const initialize = (id: number, clientCapabilities: Record<string, unknown> = {}) => ({
	jsonrpc: "2.0",
	id,
	method: "initialize",
	params: { protocolVersion: 1, clientCapabilities },
});
const initialized = (id: number) => ({ jsonrpc: "2.0", id, result: { protocolVersion: 1 } });
const newSession = (id: number) => ({ jsonrpc: "2.0", id, method: "session/new", params: { cwd: "/w", mcpServers: [] } });
const update = (sessionId: string, value: Record<string, unknown>) => ({
	jsonrpc: "2.0",
	method: "session/update",
	params: { sessionId, update: value },
});
const text = { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "hi" } };

/** A monitor that has seen initialize and session/new for session "s". */
function connected(clientCapabilities: Record<string, unknown> = {}): ConformanceMonitor {
	const monitor = new ConformanceMonitor();
	monitor.fromClient(initialize(1, clientCapabilities));
	monitor.fromAgent(initialized(1));
	monitor.fromClient(newSession(2));
	monitor.fromAgent({ jsonrpc: "2.0", id: 2, result: { sessionId: "s" } });
	return monitor;
}

const rules = (monitor: ConformanceMonitor) => monitor.violations.map((v) => v.rule);

describe("the conformance monitor", () => {
	it("accepts a well-formed exchange", () => {
		const monitor = connected({ session: { notices: {} } });
		monitor.fromAgent(update("s", text));
		monitor.fromAgent(update("s", { sessionUpdate: "notice", severity: "info", title: "t" }));
		monitor.fromAgent(update("s", { sessionUpdate: "tool_call", toolCallId: "t1", title: "Read" }));
		monitor.fromAgent(update("s", { sessionUpdate: "tool_call_update", toolCallId: "t1", status: "completed" }));
		expect(monitor.violations).toEqual([]);
		expect(monitor.checked).toContain("SessionNotification");
	});

	it("flags payloads that break the schema, in either direction", () => {
		const monitor = connected();
		monitor.fromAgent(update("s", { sessionUpdate: "agent_message_chunk", content: { type: "text" } }));
		monitor.fromClient({ jsonrpc: "2.0", id: 3, method: "session/prompt", params: { sessionId: "s" } });
		monitor.fromAgent({ jsonrpc: "2.0", id: 3, result: { stopReason: "finished" } });
		expect(monitor.violations.map((v) => [v.direction, v.rule])).toEqual([
			["agent→client", "schema"],
			["client→agent", "schema"],
			["agent→client", "schema"],
		]);
	});

	it("checks results against the method they answer", () => {
		const monitor = connected();
		// A valid LogoutResponse, but not a valid NewSessionResponse.
		monitor.fromClient(newSession(3));
		monitor.fromAgent({ jsonrpc: "2.0", id: 3, result: {} });
		expect(monitor.violations[0]?.detail).toContain("NewSessionResponse");
	});

	it("flags broken JSON-RPC framing and response bookkeeping", () => {
		const monitor = connected();
		monitor.fromAgent("not json");
		monitor.fromAgent({ jsonrpc: "1.0", method: "session/update", params: { sessionId: "s", update: text } });
		monitor.fromAgent({ jsonrpc: "2.0", id: 99, result: {} });
		monitor.fromAgent({ jsonrpc: "2.0", id: 2, result: { sessionId: "s" } });
		expect(rules(monitor)).toEqual(["framing", "framing", "response-id", "response-id"]);
	});

	it("flags anything the agent sends before initialize completes", () => {
		const monitor = new ConformanceMonitor();
		monitor.fromClient(initialize(1));
		monitor.fromAgent(update("s", text));
		expect(rules(monitor)).toContain("before-initialize");
	});

	it("flags an initialize answered with a newer protocol version than requested", () => {
		const monitor = new ConformanceMonitor();
		monitor.fromClient(initialize(1));
		monitor.fromAgent({ jsonrpc: "2.0", id: 1, result: { protocolVersion: 2 } });
		expect(rules(monitor)).toEqual(["protocol-version"]);
	});

	it("flags updates for sessions the client does not know, or has closed", () => {
		const monitor = connected();
		monitor.fromAgent(update("other", text));
		monitor.fromClient({ jsonrpc: "2.0", id: 3, method: "session/close", params: { sessionId: "s" } });
		monitor.fromAgent({ jsonrpc: "2.0", id: 3, result: {} });
		monitor.fromAgent(update("s", text));
		expect(monitor.violations.map((v) => v.detail)).toEqual([
			expect.stringContaining("before the client knew it existed"),
			expect.stringContaining("after the client closed or deleted it"),
		]);
	});

	it("flags an update sent before the session/new response", () => {
		const monitor = new ConformanceMonitor();
		monitor.fromClient(initialize(1));
		monitor.fromAgent(initialized(1));
		monitor.fromClient(newSession(2));
		monitor.fromAgent(update("s", text));
		monitor.fromAgent({ jsonrpc: "2.0", id: 2, result: { sessionId: "s" } });
		expect(rules(monitor)).toEqual(["session"]);
	});

	it("flags features the client did not advertise", () => {
		const monitor = connected();
		monitor.fromAgent(update("s", { sessionUpdate: "notice", severity: "info", title: "t" }));
		monitor.fromAgent(update("s", { sessionUpdate: "compaction_update", compactionId: "c", status: "in_progress" }));
		monitor.fromAgent({ jsonrpc: "2.0", id: "a1", method: "fs/read_text_file", params: { sessionId: "s", path: "/x" } });
		monitor.fromAgent({
			jsonrpc: "2.0",
			id: "a2",
			method: "elicitation/create",
			params: { mode: "form", sessionId: "s", message: "m", requestedSchema: { type: "object", properties: {} } },
		});
		expect(rules(monitor)).toEqual(["capability", "capability", "capability", "capability"]);
	});

	it("flags tool call updates for tool calls never announced", () => {
		const monitor = connected();
		monitor.fromAgent(update("s", { sessionUpdate: "tool_call_update", toolCallId: "ghost", status: "completed" }));
		monitor.fromAgent({
			jsonrpc: "2.0",
			id: "a1",
			method: "session/request_permission",
			params: { sessionId: "s", toolCall: { toolCallId: "ghost2" }, options: [] },
		});
		expect(rules(monitor)).toEqual(["tool-call", "tool-call"]);
	});

	it("flags unknown methods and cancellations of requests never sent", () => {
		const monitor = connected();
		monitor.fromAgent({ jsonrpc: "2.0", id: "a1", method: "session/telepathy", params: {} });
		monitor.fromAgent({ jsonrpc: "2.0", method: "$/cancel_request", params: { requestId: "never" } });
		monitor.fromAgent({ jsonrpc: "2.0", method: "_vendor/extension", params: {} });
		expect(rules(monitor)).toEqual(["unknown-method", "cancel-request"]);
	});
});

describe("the conformance monitor, for a v2 client", () => {
	/** A monitor that has seen a v2 initialize and session/new for session "s". */
	function connectedV2(): ConformanceMonitor {
		const monitor = new ConformanceMonitor();
		monitor.fromClient({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: 2, info: { name: "c", version: "0" } } });
		monitor.fromAgent({ jsonrpc: "2.0", id: 1, result: { protocolVersion: 2, info: { name: "a", version: "0" } } });
		monitor.fromClient({ jsonrpc: "2.0", id: 2, method: "session/new", params: { cwd: "/w" } });
		monitor.fromAgent({ jsonrpc: "2.0", id: 2, result: { sessionId: "s" } });
		return monitor;
	}
	const prompt = (id: number) => ({
		jsonrpc: "2.0",
		id,
		method: "session/prompt",
		params: { sessionId: "s", prompt: [{ type: "text", text: "hi" }] },
	});

	it("checks frames against the v2 schema", () => {
		const monitor = connectedV2();
		monitor.fromClient(prompt(3));
		monitor.fromAgent(update("s", { sessionUpdate: "user_message", messageId: "u1", content: [{ type: "text", text: "hi" }] }));
		monitor.fromAgent({ jsonrpc: "2.0", id: 3, result: { messageId: "u1" } });
		monitor.fromAgent(update("s", { sessionUpdate: "tool_call_update", toolCallId: "t1", status: "completed" }));
		monitor.fromAgent(update("s", { sessionUpdate: "state_update", state: "idle", stopReason: "end_turn" }));
		monitor.finish();
		expect(monitor.violations).toEqual([]);

		// v1 shapes are not v2: a chunk without its message id, a v1 prompt result.
		monitor.fromAgent(update("s", text));
		monitor.fromClient(prompt(4));
		monitor.fromAgent({ jsonrpc: "2.0", id: 4, result: { stopReason: "end_turn" } });
		expect(rules(monitor)).toEqual(["schema", "schema"]);
	});

	it("flags v1-only updates", () => {
		const monitor = connectedV2();
		monitor.fromAgent(update("s", { sessionUpdate: "tool_call", toolCallId: "t1", title: "Read" }));
		expect(rules(monitor)).toContain("version");
	});

	it("flags an accepted prompt that is never echoed as a user message", () => {
		const monitor = connectedV2();
		monitor.fromClient(prompt(3));
		monitor.fromAgent({ jsonrpc: "2.0", id: 3, result: { messageId: "u1" } });
		monitor.finish();
		expect(rules(monitor)).toEqual(["user-message"]);
	});

	it("flags a session/resume answered without a state update first", () => {
		const monitor = connectedV2();
		monitor.fromClient({ jsonrpc: "2.0", id: 3, method: "session/resume", params: { sessionId: "s", cwd: "/w" } });
		monitor.fromAgent({ jsonrpc: "2.0", id: 3, result: {} });
		expect(rules(monitor)).toEqual(["state"]);
	});
});

/** Every scenario the mock pi can play, by the marker that selects it. */
const SCENARIOS = [
	"TEXT",
	"THINK",
	"EDIT",
	"BASH",
	"TOOLFAIL",
	"ERROR",
	"RETRY",
	"CONFIRM",
	"NESTED",
	"SELECT",
	"INPUT",
	"EDITOR",
	"NOTIFY",
	"NOOP",
	"SELFABORT",
	"LEVELCHANGE",
	"RENAME",
	"UNNAME",
	"COMPACT",
	"COMPACTFAIL",
	"MODELCHANGE",
	"NOSTATS",
];

const EVERYTHING = {
	fs: { readTextFile: true, writeTextFile: true },
	terminal: true,
	session: { notices: {}, compaction: {} },
	elicitation: { form: {}, url: {} },
};

/** Drive one client through every scenario and session method the adapter serves. */
async function sweep(client: TestClient, workspace: string, clientCapabilities: Record<string, unknown>): Promise<void> {
	client.permissionAnswer = "yes";
	client.elicitationAnswer = () => ({ action: "accept", content: { value: "red" } });

	await client.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities });
	const { sessionId } = await client.newSession({ cwd: workspace, mcpServers: [] });
	for (const scenario of SCENARIOS) {
		await client.prompt({ sessionId, prompt: [{ type: "text", text: `${scenario} please` }] }).catch(() => {
			// ERROR deliberately fails the turn; the error response is still checked.
		});
	}

	const slow = client.prompt({ sessionId, prompt: [{ type: "text", text: "SLOW please" }] });
	await client.waitFor((updates) => updates.some((u) => u.sessionUpdate === "agent_message_chunk"));
	client.cancel(sessionId);
	await slow;

	await client.setConfigOption(sessionId, "model", "openai/gpt-5");
	await client.setConfigOption(sessionId, "thinking", "off");
	await client.setConfigOption(sessionId, "nope", "x").catch(() => {});
	await client.request("session/list", { cwd: workspace });
	await client.request("session/list", { cursor: "bad" }).catch(() => {});
	await client.loadSession({ sessionId, cwd: workspace, mcpServers: [] });
	await client.request("session/resume", { sessionId, cwd: workspace, mcpServers: [] });
	await client.prompt({ sessionId, prompt: [{ type: "text", text: "TEXT again" }] });
	await client.request("session/close", { sessionId });
	await client.request("session/delete", { sessionId: path.join(workspace, "missing.jsonl") }).catch(() => {});
	await client.request("authenticate", { methodId: "none" }).catch(() => {});
	await client.request("session/set_mode", { sessionId, modeId: "x" }).catch(() => {});
	// Let anything the adapter sends after the last response arrive.
	await new Promise((resolve) => setTimeout(resolve, 200));
}

describe("ACP conformance sweep", () => {
	it.each([
		["advertises nothing", {}],
		["advertises everything", EVERYTHING],
	])("stays within ACP v1 for a client that %s", async (_label, capabilities) => {
		const { client, workspace, cleanup } = createTestClient({
			extraArgs: (dir) => ["--session-dir", path.join(dir, "store")],
		});
		// A pi session store with one session, so session/list has something to return.
		const store = path.join(workspace, "store");
		mkdirSync(store);
		writeFileSync(
			path.join(store, "1.jsonl"),
			`${JSON.stringify({ type: "session", version: 3, id: "x", timestamp: "2026-01-01T00:00:00.000Z", cwd: workspace })}\n`,
		);
		try {
			await sweep(client, workspace, capabilities);

			// The setup file fails the test on any violation; also prove the sweep
			// reached the parts of the protocol it is meant to cover.
			const kinds = new Set(client.updates.map((u) => u.sessionUpdate));
			for (const kind of [
				"agent_message_chunk",
				"agent_thought_chunk",
				"user_message_chunk",
				"tool_call",
				"tool_call_update",
				"available_commands_update",
				"config_option_update",
				"usage_update",
				"session_info_update",
			]) {
				expect(kinds, kind).toContain(kind);
			}
			for (const definition of [
				"InitializeResponse",
				"NewSessionResponse",
				"LoadSessionResponse",
				"ResumeSessionResponse",
				"ListSessionsResponse",
				"CloseSessionResponse",
				"PromptResponse",
				"SetSessionConfigOptionResponse",
				"SessionNotification",
				"RequestPermissionRequest",
				"Error",
			]) {
				expect(client.conformance.checked, definition).toContain(definition);
			}

			const advertised = capabilities === EVERYTHING;
			expect(kinds.has("notice")).toBe(advertised);
			expect(kinds.has("compaction_update")).toBe(advertised);
			expect(client.conformance.checked.has("CreateElicitationRequest")).toBe(advertised);
			expect(client.conformance.checked.has("ReadTextFileRequest")).toBe(advertised);
		} finally {
			cleanup();
		}
	}, 60_000);
});
