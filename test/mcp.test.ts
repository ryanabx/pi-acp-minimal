import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PROTOCOL_VERSION } from "@agentclientprotocol/sdk";
import { literalConfigValue, toPiMcpServers } from "../src/map/mcp.js";
import acpMcpServers from "../pi-extension/acp-mcp-servers.js";
import { createTestClient } from "./harness.js";

describe("ACP MCP servers -> pi", () => {
	it("converts stdio and HTTP servers and drops SSE", () => {
		const warn = vi.fn();
		const servers = toPiMcpServers(
			[
				{ name: "files", command: "/usr/bin/mcp-files", args: ["--root", "/w"], env: [{ name: "TOKEN", value: "abc" }] },
				{ type: "http", name: "docs", url: "https://example.com/mcp", headers: [{ name: "Authorization", value: "Bearer x" }] },
				{ type: "sse", name: "old", url: "https://example.com/sse", headers: [] },
				{ name: "bare", command: "/bin/srv", args: [], env: [] },
			],
			warn,
		);
		expect(servers).toEqual({
			files: { command: "/usr/bin/mcp-files", args: ["--root", "/w"], env: { TOKEN: "abc" } },
			docs: { url: "https://example.com/mcp", headers: { Authorization: "Bearer x" } },
			bare: { command: "/bin/srv", args: [] },
		});
		expect(warn).toHaveBeenCalledWith(expect.stringContaining('"old"'));
	});

	it("makes names valid and distinct for pi", () => {
		const stdio = (name: string) => ({ name, command: "/bin/x", args: [], env: [] });
		const names = Object.keys(
			toPiMcpServers([stdio("My Server!"), stdio("my_server"), stdio("my-server"), stdio("My_Server"), stdio("???")], vi.fn()),
		);
		// pi treats names differing only in "-" and "_" as one server.
		expect(names).toEqual(["My_Server", "my_server", "my-server_2", "My_Server_2", "server"]);
	});

	it("escapes values so pi does not expand or run them", () => {
		expect(literalConfigValue("plain")).toBe("plain");
		expect(literalConfigValue("${HOME}/x")).toBe("$${HOME}/x");
		expect(literalConfigValue("$USER")).toBe("$$USER");
		expect(literalConfigValue("!rm -rf /")).toBe("$!rm -rf /");
		expect(literalConfigValue("a!b")).toBe("a!b");
	});
});

describe("the pi extension", () => {
	afterEach(() => {
		delete process.env.PI_ACP_MCP_SERVERS;
	});

	it("registers the servers and removes the variable before any tool can read it", () => {
		const config = { files: { command: "/bin/x", args: [] }, docs: { url: "https://example.com/mcp" } };
		process.env.PI_ACP_MCP_SERVERS = JSON.stringify(config);
		const registerMcpServer = vi.fn();
		acpMcpServers({ registerMcpServer });
		expect(registerMcpServer.mock.calls).toEqual([
			["files", config.files],
			["docs", config.docs],
		]);
		expect(process.env.PI_ACP_MCP_SERVERS).toBeUndefined();
	});

	it("keeps going when pi rejects one server or cannot register any", () => {
		const errors = vi.spyOn(console, "error").mockImplementation(() => {});
		try {
			process.env.PI_ACP_MCP_SERVERS = JSON.stringify({ bad: {}, good: { command: "/bin/x", args: [] } });
			const registerMcpServer = vi.fn((name: string) => {
				if (name === "bad") throw new Error("invalid config");
			});
			acpMcpServers({ registerMcpServer });
			expect(registerMcpServer).toHaveBeenCalledTimes(2);

			process.env.PI_ACP_MCP_SERVERS = JSON.stringify({ good: { command: "/bin/x", args: [] } });
			expect(() => acpMcpServers({})).not.toThrow();
			expect(errors).toHaveBeenCalledTimes(2);
		} finally {
			errors.mockRestore();
		}
	});
});

describe("session/new with MCP servers", () => {
	let dir: string;
	afterEach(() => rmSync(dir, { recursive: true, force: true }));

	it("loads the extension and hands it the servers only when there are any", async () => {
		dir = mkdtempSync(path.join(tmpdir(), "pi-acp-mcp-"));
		const record = path.join(dir, "launches.jsonl");
		const { client, workspace, cleanup } = createTestClient({ env: { MOCK_PI_RECORD: record } });
		try {
			const init = await client.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} });
			expect(init.agentCapabilities?.mcpCapabilities).toEqual({ http: true, sse: false });

			await client.newSession({ cwd: workspace, mcpServers: [] });
			await client.newSession({
				cwd: workspace,
				mcpServers: [{ name: "files", command: "/usr/bin/mcp-files", args: [], env: [{ name: "K", value: "$v" }] }],
			});

			const launches = readFileSync(record, "utf8")
				.trim()
				.split("\n")
				.map((line) => JSON.parse(line) as { argv: string[]; mcpServers: string | null });
			const extension = path.resolve("pi-extension/acp-mcp-servers.js");
			expect(launches[0]).toEqual({ argv: ["--mode", "rpc"], mcpServers: null });
			const argv = launches[1]?.argv ?? [];
			expect(argv[argv.indexOf("-e") + 1]).toBe(extension);
			expect(JSON.parse(launches[1]!.mcpServers!)).toEqual({
				files: { command: "/usr/bin/mcp-files", args: [], env: { K: "$$v" } },
			});
		} finally {
			cleanup();
		}
	});
});
