import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PROTOCOL_VERSION } from "@agentclientprotocol/sdk";
import { AdapterError, createTestClient, type TestClient } from "./harness.js";

let client: TestClient;
let workspace: string;
let cleanup: () => void;

beforeEach(async () => {
	({ client, workspace, cleanup } = createTestClient());
	await client.initialize({
		protocolVersion: PROTOCOL_VERSION,
		// readTextFile is advertised so the diff snapshots exercise the client-fs
		// path; the harness only serves files it has been given explicitly, which
		// also covers the local-disk fallback.
		clientCapabilities: { fs: { readTextFile: true, writeTextFile: false }, terminal: false },
	});
});

afterEach(() => cleanup());

async function newSession() {
	return client.newSession({ cwd: workspace, mcpServers: [] });
}

/** Pull one config option out of a `configOptions` list by id. */
function configOption(options: unknown, id: string): any {
	const found = (options as any[] | null | undefined)?.find((option) => option.id === id);
	if (!found) throw new Error(`no config option "${id}" in ${JSON.stringify(options)}`);
	return found;
}

describe("initialize", () => {
	it("advertises pi's capabilities", async () => {
		const { client: fresh, cleanup: done } = createTestClient();
		try {
			const response = await fresh.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} });
			expect(response.protocolVersion).toBe(PROTOCOL_VERSION);
			expect(response.agentCapabilities?.loadSession).toBe(true);
			expect(response.agentCapabilities?.promptCapabilities).toMatchObject({ image: true, embeddedContext: true });
		} finally {
			done();
		}
	});
});

describe("session/new", () => {
	it("exposes pi's models and thinking levels as config options", async () => {
		const session = await newSession();
		expect(session.sessionId).toContain("mock-session-1");

		const model = configOption(session.configOptions, "model");
		expect(model.category).toBe("model");
		expect(model.currentValue).toBe("anthropic/claude-sonnet-4");
		// Two providers, so the picker is grouped.
		expect(model.options).toEqual([
			{ group: "anthropic", name: "anthropic", options: [expect.objectContaining({ value: "anthropic/claude-sonnet-4" })] },
			{ group: "openai", name: "openai", options: [expect.objectContaining({ value: "openai/gpt-5" })] },
		]);

		const thinking = configOption(session.configOptions, "thinking");
		expect(thinking.category).toBe("thought_level");
		expect(thinking.currentValue).toBe("off");
		expect(thinking.options.map((o: any) => o.value)).toEqual(["off", "low", "medium", "high"]);
	});

	it("responds to session/new before notifying about it", async () => {
		// A client cannot route a session/update for a session it does not know yet.
		const session = await newSession();
		expect(client.updates).toHaveLength(0);
		await client.waitFor((updates) => updates.some((u) => u.sessionUpdate === "available_commands_update"));
		expect(session.sessionId).toBeTruthy();
	});

	it("publishes pi slash commands", async () => {
		await newSession();
		await client.waitFor((updates) => updates.some((u) => u.sessionUpdate === "available_commands_update"));
		const update = client.updates.find((u) => u.sessionUpdate === "available_commands_update");
		expect(update).toBeDefined();
		if (update?.sessionUpdate !== "available_commands_update") throw new Error("unreachable");
		expect(update.availableCommands.map((c) => c.name)).toEqual(["review", "skill:search"]);
		expect(update.availableCommands[0]?.description).toBe("Review the diff (prompt template, project)");
	});
});

describe("session/prompt", () => {
	it("streams assistant text and ends the turn", async () => {
		const { sessionId } = await newSession();
		const response = await client.prompt({ sessionId, prompt: [{ type: "text", text: "TEXT please" }] });
		expect(response.stopReason).toBe("end_turn");
		expect(client.agentText()).toContain("Hello, world!");
	});

	it("routes thinking to agent_thought_chunk", async () => {
		const { sessionId } = await newSession();
		await client.prompt({ sessionId, prompt: [{ type: "text", text: "THINK about it" }] });
		expect(client.thoughtText()).toBe("pondering");
		expect(client.agentText()).toContain("done thinking");
	});

	it("rejects an empty prompt", async () => {
		const { sessionId } = await newSession();
		await expect(client.prompt({ sessionId, prompt: [] })).rejects.toThrow();
	});

	it("rejects an unknown session", async () => {
		await expect(
			client.prompt({ sessionId: "nope", prompt: [{ type: "text", text: "TEXT" }] }),
		).rejects.toThrow();
	});

	it("surfaces a failed turn as a JSON-RPC error", async () => {
		const { sessionId } = await newSession();
		await expect(
			client.prompt({ sessionId, prompt: [{ type: "text", text: "ERROR now" }] }),
		).rejects.toThrow(/Connection error/);
	});

	it("reports auto-retry progress and still completes", async () => {
		const { sessionId } = await newSession();
		const response = await client.prompt({ sessionId, prompt: [{ type: "text", text: "RETRY please" }] });
		expect(response.stopReason).toBe("end_turn");
		expect(client.agentText()).toMatch(/Retrying after error \(attempt 1\/3/);
		expect(client.agentText()).toContain("Hello, world!");
	});

	it("ends the turn for extension commands that never run the agent", async () => {
		const { sessionId } = await newSession();
		const response = await client.prompt({ sessionId, prompt: [{ type: "text", text: "/NOOP" }] });
		expect(response.stopReason).toBe("end_turn");
	});
});

describe("tool calls", () => {
	it("maps a file write to a diff with the pre-edit contents", async () => {
		const { sessionId } = await newSession();
		await client.prompt({ sessionId, prompt: [{ type: "text", text: "EDIT the file" }] });

		const updates = client.toolUpdates("call-edit");
		const first = updates[0];
		expect(first?.sessionUpdate).toBe("tool_call");
		if (first?.sessionUpdate !== "tool_call") throw new Error("unreachable");
		expect(first.status).toBe("pending");
		expect(first.kind).toBe("edit");

		const last = updates.at(-1);
		if (last?.sessionUpdate !== "tool_call_update") throw new Error("unreachable");
		expect(last.status).toBe("completed");
		expect(last.content?.[0]).toEqual({
			type: "diff",
			path: path.join(workspace, "edited.txt"),
			oldText: "before\n",
			newText: "after\n",
		});

		const titled = updates.find((u) => "title" in u && u.title === "Write edited.txt");
		expect(titled).toBeDefined();
	});

	it("maps bash output to text content and marks the call executed", async () => {
		const { sessionId } = await newSession();
		await client.prompt({ sessionId, prompt: [{ type: "text", text: "BASH it" }] });

		const updates = client.toolUpdates("call-bash");
		const announced = updates[0];
		if (announced?.sessionUpdate !== "tool_call") throw new Error("unreachable");
		expect(announced.kind).toBe("execute");

		const titled = updates.find((u) => "title" in u && u.title === "echo hi");
		expect(titled).toBeDefined();

		const last = updates.at(-1);
		if (last?.sessionUpdate !== "tool_call_update") throw new Error("unreachable");
		expect(last.status).toBe("completed");
		expect(last.content?.[0]).toEqual({ type: "content", content: { type: "text", text: "hi\n" } });
		expect(last.rawOutput).toEqual({ exitCode: 0 });
	});

	it("prefers the client's file system for diff snapshots", async () => {
		client.clientFsEnabled = true;
		// An unsaved editor buffer the adapter should see instead of what is on disk.
		client.clientFiles.set(path.join(workspace, "edited.txt"), "unsaved buffer\n");

		const { sessionId } = await newSession();
		await client.prompt({ sessionId, prompt: [{ type: "text", text: "EDIT the file" }] });

		const last = client.toolUpdates("call-edit").at(-1);
		if (last?.sessionUpdate !== "tool_call_update") throw new Error("unreachable");
		expect(last.content?.[0]).toMatchObject({ type: "diff", oldText: "unsaved buffer\n" });
	});

	it("marks a failing tool call as failed", async () => {
		const { sessionId } = await newSession();
		await client.prompt({ sessionId, prompt: [{ type: "text", text: "TOOLFAIL" }] });

		const last = client.toolUpdates("call-read").at(-1);
		if (last?.sessionUpdate !== "tool_call_update") throw new Error("unreachable");
		expect(last.status).toBe("failed");
		expect(last.content?.[0]).toEqual({ type: "content", content: { type: "text", text: "ENOENT: no such file" } });
	});

	it("reports read locations so clients can follow along", async () => {
		const { sessionId } = await newSession();
		await client.prompt({ sessionId, prompt: [{ type: "text", text: "TOOLFAIL" }] });
		const located = client
			.toolUpdates("call-read")
			.find((u) => "locations" in u && (u.locations?.length ?? 0) > 0);
		if (!located || !("locations" in located)) throw new Error("no locations reported");
		expect(located.locations?.[0]?.path).toBe(path.join(workspace, "missing.txt"));
	});
});

describe("session/cancel", () => {
	it("aborts pi and resolves the turn as cancelled", async () => {
		const { sessionId } = await newSession();
		const pending = client.prompt({ sessionId, prompt: [{ type: "text", text: "SLOW down" }] });
		await client.waitFor((updates) => updates.some((u) => u.sessionUpdate === "agent_message_chunk"));
		client.cancel(sessionId);
		await expect(pending).resolves.toEqual({ stopReason: "cancelled" });
	});
});

describe("session/set_config_option", () => {
	it("switches models and returns the refreshed options", async () => {
		const { sessionId } = await newSession();
		const result = await client.setConfigOption(sessionId, "model", "openai/gpt-5");
		expect(configOption(result.configOptions, "model").currentValue).toBe("openai/gpt-5");
	});

	it("rejects an unknown model", async () => {
		const { sessionId } = await newSession();
		await expect(client.setConfigOption(sessionId, "model", "openai/nope")).rejects.toThrow(/Model not found/);
	});

	it("switches thinking level on a model that supports reasoning", async () => {
		const { sessionId } = await newSession();
		const result = await client.setConfigOption(sessionId, "thinking", "high");
		expect(configOption(result.configOptions, "thinking").currentValue).toBe("high");
	});

	it("offers only the levels pi reports when the model supports reasoning", async () => {
		const session = await newSession();
		const thinking = configOption(session.configOptions, "thinking");
		expect(thinking.options.map((o: any) => o.value)).toEqual(["off", "low", "medium", "high"]);
	});

	it("reports the level pi clamped to rather than the one requested", async () => {
		const { sessionId } = await newSession();
		// The mock's sonnet tops out at "high", so pi clamps a request for "max".
		const result = await client.setConfigOption(sessionId, "thinking", "max");
		expect(configOption(result.configOptions, "thinking").currentValue).toBe("high");
	});

	it("drops the thinking control when pi says the model has no reasoning support", async () => {
		const { sessionId } = await newSession();
		const result = await client.setConfigOption(sessionId, "model", "openai/gpt-5");
		expect((result.configOptions as any[]).map((o) => o.id)).toEqual(["model"]);
	});

	it("rejects a value that is not a pi thinking level at all", async () => {
		const { sessionId } = await newSession();
		await expect(client.setConfigOption(sessionId, "thinking", "ludicrous")).rejects.toThrow(
			/Unknown thinking level/,
		);
	});

	it("pushes a config_option_update when pi's model metadata changes mid-session", async () => {
		const { sessionId } = await newSession();
		await client.prompt({ sessionId, prompt: [{ type: "text", text: "MODELCHANGE please" }] });

		const update = client.updates.find((u) => u.sessionUpdate === "config_option_update");
		if (update?.sessionUpdate !== "config_option_update") throw new Error("no config_option_update");
		const model = configOption(update.configOptions, "model");
		const anthropic = model.options[0].options[0];
		expect(anthropic.description).toBe("anthropic · 99k context · reasoning");
	});

	it("does not re-announce config options that have not changed", async () => {
		const { sessionId } = await newSession();
		await client.prompt({ sessionId, prompt: [{ type: "text", text: "TEXT please" }] });
		expect(client.updates.filter((u) => u.sessionUpdate === "config_option_update")).toHaveLength(0);
	});

	it("rejects an unknown config option", async () => {
		const { sessionId } = await newSession();
		await expect(client.setConfigOption(sessionId, "nonsense", "x")).rejects.toThrow(/Unknown config option/);
	});
});

describe("extension UI bridge", () => {
	it("turns a pi confirm dialog into an ACP permission request", async () => {
		const { sessionId } = await newSession();
		client.permissionAnswer = "yes";
		await client.prompt({ sessionId, prompt: [{ type: "text", text: "CONFIRM this" }] });

		expect(client.permissionRequests).toHaveLength(1);
		const request = client.permissionRequests[0]!;
		expect(request.toolCall.title).toContain("Run dangerous command?");
		expect(request.options.map((o) => o.kind)).toEqual(["allow_once", "reject_once"]);
		expect(client.agentText()).toContain("confirmed");
	});

	it("passes a declined confirm back to pi", async () => {
		const { sessionId } = await newSession();
		client.permissionAnswer = "no";
		await client.prompt({ sessionId, prompt: [{ type: "text", text: "CONFIRM this" }] });
		expect(client.agentText()).toContain("declined");
	});

	it("surfaces extension notifications as agent messages", async () => {
		const { sessionId } = await newSession();
		await client.prompt({ sessionId, prompt: [{ type: "text", text: "NOTIFY me" }] });
		expect(client.agentText()).toContain("heads up");
	});
});

describe("thinking levels pi cannot report", () => {
	it("drops the control when pi gives no answer", async () => {
		const { client: blind, workspace: dir, cleanup: done } = createTestClient({
			env: { MOCK_PI_NO_THINKING_LEVELS: "1" },
		});
		try {
			await blind.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} });
			const session = await blind.newSession({ cwd: dir, mcpServers: [] });
			expect((session.configOptions ?? []).map((o) => o.id)).toEqual(["model"]);
		} finally {
			done();
		}
	});
});

describe("usage reporting", () => {
	it("reports context occupancy once the session is created", async () => {
		await newSession();
		await client.waitFor((updates) => updates.some((u) => u.sessionUpdate === "usage_update"));
		const update = client.updates.find((u) => u.sessionUpdate === "usage_update");
		if (update?.sessionUpdate !== "usage_update") throw new Error("unreachable");
		expect(update.size).toBe(200_000);
		expect(update.used).toBe(0);
		expect(update.cost).toEqual({ amount: 0, currency: "USD" });
	});

	it("updates as the context fills up", async () => {
		const { sessionId } = await newSession();
		await client.waitFor((updates) => updates.some((u) => u.sessionUpdate === "usage_update"));
		await client.prompt({ sessionId, prompt: [{ type: "text", text: "TEXT please" }] });

		const used = client.updates
			.filter((u) => u.sessionUpdate === "usage_update")
			.map((u) => (u.sessionUpdate === "usage_update" ? u.used : -1));
		expect(used[0]).toBe(0);
		expect(used.at(-1)).toBeGreaterThan(0);
		// Identical figures are not re-sent.
		expect(new Set(used).size).toBe(used.length);
	});

	it("stays quiet when pi has no context figure to report", async () => {
		const { sessionId } = await newSession();
		await client.prompt({ sessionId, prompt: [{ type: "text", text: "NOSTATS please" }] });
		const afterPrompt = client.updates
			.filter((u) => u.sessionUpdate === "usage_update")
			.map((u) => (u.sessionUpdate === "usage_update" ? u.used : -1));
		// Only the session-start report; the turn itself yielded nothing new.
		expect(afterPrompt).toEqual([0]);
	});
});

describe("session/load", () => {
	it("replays the stored conversation", async () => {
		const { sessionId } = await newSession();
		await client.prompt({ sessionId, prompt: [{ type: "text", text: "TEXT please" }] });

		const before = client.updates.length;
		const loaded = await client.loadSession({ sessionId, cwd: workspace, mcpServers: [] });
		expect(configOption(loaded.configOptions, "model").currentValue).toBe("anthropic/claude-sonnet-4");

		const replayed = client.updates.slice(before);
		expect(replayed.some((u) => u.sessionUpdate === "user_message_chunk")).toBe(true);
		expect(
			replayed.some((u) => u.sessionUpdate === "agent_message_chunk" && u.content.type === "text" && u.content.text.includes("Hello, world!")),
		).toBe(true);
	});
});

describe("prompt content mapping", () => {
	it("inlines embedded resources so pi sees the file contents", async () => {
		const file = path.join(workspace, "notes.md");
		writeFileSync(file, "remember this");
		const { sessionId } = await newSession();
		await client.prompt({
			sessionId,
			prompt: [
				{ type: "text", text: "TEXT summarize" },
				{ type: "resource", resource: { uri: `file://${file}`, mimeType: "text/markdown", text: readFileSync(file, "utf8") } },
			],
		});
		expect(client.agentText()).toContain("Hello, world!");
	});
});
