import { describe, expect, it } from "vitest";
import { toAcpCommand } from "../src/map/commands.js";
import { contentToText, toAcpContentBlocks, toPiPrompt, uriToPath } from "../src/map/content.js";
import { buildConfigOptions, isThinkingLevel, modelConfigOption, thinkingConfigOption } from "../src/map/config.js";
import { describeModel, fromAcpModelId, toAcpModelId } from "../src/map/models.js";
import { displayPath, isFileMutatingTool, toolKind, toolLocations, toolTitle } from "../src/map/tools.js";
import { toAcpUsageUpdate } from "../src/map/usage.js";

describe("prompt content", () => {
	it("joins text blocks and collects images", () => {
		const result = toPiPrompt([
			{ type: "text", text: "look at this" },
			{ type: "image", data: "AAAA", mimeType: "image/png" },
			{ type: "text", text: "and this" },
		]);
		expect(result.message).toBe("look at this\n\nand this");
		expect(result.images).toEqual([{ type: "image", data: "AAAA", mimeType: "image/png" }]);
	});

	it("turns resource links into pi @-mentions", () => {
		const result = toPiPrompt([{ type: "resource_link", name: "a.ts", uri: "file:///tmp/a.ts" }]);
		expect(result.message).toBe("@/tmp/a.ts");
	});

	it("inlines embedded text resources", () => {
		const result = toPiPrompt([
			{ type: "resource", resource: { uri: "file:///tmp/a.ts", mimeType: "text/plain", text: "hi" } },
		]);
		expect(result.message).toBe('<context path="/tmp/a.ts">\nhi\n</context>');
	});

	it("falls back to a mention for binary embedded resources", () => {
		const result = toPiPrompt([
			{ type: "resource", resource: { uri: "file:///tmp/a.bin", mimeType: "application/octet-stream", blob: "AA" } },
		]);
		expect(result.message).toBe("@/tmp/a.bin");
	});

	it("decodes percent-encoded file URIs", () => {
		expect(uriToPath("file:///tmp/my%20file.ts")).toBe("/tmp/my file.ts");
		expect(uriToPath("zed://something")).toBe("zed://something");
	});
});

describe("pi content", () => {
	it("converts string and array content to ACP blocks", () => {
		expect(toAcpContentBlocks("hi")).toEqual([{ type: "text", text: "hi" }]);
		expect(toAcpContentBlocks([{ type: "image", data: "A", mimeType: "image/png" }])).toEqual([
			{ type: "image", data: "A", mimeType: "image/png" },
		]);
		expect(toAcpContentBlocks("")).toEqual([]);
	});

	it("flattens content to text", () => {
		expect(contentToText([{ type: "text", text: "a" }, { type: "image", data: "A", mimeType: "image/png" }, { type: "text", text: "b" }])).toBe("ab");
	});
});

describe("models", () => {
	it("round-trips provider-qualified ids", () => {
		const model = { id: "claude-sonnet-4", provider: "anthropic" };
		expect(toAcpModelId(model)).toBe("anthropic/claude-sonnet-4");
		expect(fromAcpModelId("anthropic/claude-sonnet-4")).toEqual({ provider: "anthropic", modelId: "claude-sonnet-4" });
	});

	it("keeps slashes in the model portion", () => {
		expect(fromAcpModelId("openrouter/meta/llama-3")).toEqual({ provider: "openrouter", modelId: "meta/llama-3" });
	});

	it("rejects an unqualified id", () => {
		expect(() => fromAcpModelId("gpt-5")).toThrow();
	});

	it("summarises the model for the picker", () => {
		expect(describeModel({ id: "gpt-5", name: "GPT-5", provider: "openai", contextWindow: 400_000, reasoning: true })).toBe(
			"openai · 400k context · reasoning",
		);
	});
});

describe("config options", () => {
	const sonnet = { id: "claude-sonnet-4", name: "Sonnet", provider: "anthropic" };
	const gpt = { id: "gpt-5", name: "GPT-5", provider: "openai" };

	it("groups models by provider when there is more than one", () => {
		const option = modelConfigOption([sonnet, gpt], "anthropic/claude-sonnet-4");
		expect(option?.category).toBe("model");
		expect(option?.type).toBe("select");
		expect(option && "options" in option ? option.options : []).toEqual([
			{ group: "anthropic", name: "anthropic", options: [expect.objectContaining({ value: "anthropic/claude-sonnet-4" })] },
			{ group: "openai", name: "openai", options: [expect.objectContaining({ value: "openai/gpt-5" })] },
		]);
	});

	it("leaves a single provider's models ungrouped", () => {
		const option = modelConfigOption([sonnet], "anthropic/claude-sonnet-4");
		expect(option && "options" in option ? option.options : []).toEqual([
			{ value: "anthropic/claude-sonnet-4", name: "Sonnet", description: "anthropic" },
		]);
	});

	it("omits the model option when there is nothing to choose from", () => {
		expect(modelConfigOption([], "anthropic/claude-sonnet-4")).toBeNull();
		expect(modelConfigOption([sonnet], undefined)).toBeNull();
	});

	it("exposes thinking levels as a thought_level option", () => {
		const option = thinkingConfigOption(["off", "low", "high"], "low");
		expect(option?.category).toBe("thought_level");
		expect(option && "currentValue" in option ? option.currentValue : null).toBe("low");
	});

	it("hides the control whenever pi offers no choice", () => {
		expect(thinkingConfigOption(["off"], "off")).toBeNull();
		// A model pinned to a single non-off level is equally not a choice.
		expect(thinkingConfigOption(["high"], "high")).toBeNull();
		// As is pi being unable to tell us at all.
		expect(thinkingConfigOption([], "off")).toBeNull();
	});

	it("builds the full option list", () => {
		const options = buildConfigOptions({
			models: [sonnet],
			currentModelId: "anthropic/claude-sonnet-4",
			thinkingLevels: ["off", "high"],
			thinkingLevel: "off",
		});
		expect(options.map((o) => o.id)).toEqual(["model", "thinking"]);
	});

	it("validates thinking level ids", () => {
		expect(isThinkingLevel("medium")).toBe(true);
		expect(isThinkingLevel("architect")).toBe(false);
	});
});

describe("commands", () => {
	it("annotates a command with its kind and scope", () => {
		expect(
			toAcpCommand({ name: "review", description: "Review the diff", source: "prompt", sourceInfo: { scope: "project" } }),
		).toEqual({ name: "review", description: "Review the diff (prompt template, project)", input: { hint: "arguments" } });
	});

	it("falls back to the kind when there is no description", () => {
		expect(toAcpCommand({ name: "llama", source: "extension", sourceInfo: { scope: "temporary" } }).description).toBe(
			"extension",
		);
	});
});

describe("tools", () => {
	const cwd = "/work";

	it("classifies pi's built-in tools", () => {
		expect(toolKind("bash")).toBe("execute");
		expect(toolKind("edit")).toBe("edit");
		expect(toolKind("read")).toBe("read");
		expect(toolKind("grep")).toBe("search");
	});

	it("guesses a kind for extension tools", () => {
		expect(toolKind("web_fetch")).toBe("fetch");
		expect(toolKind("delete_branch")).toBe("delete");
		expect(toolKind("mystery")).toBe("other");
	});

	it("knows which tools change files", () => {
		expect(isFileMutatingTool("write")).toBe(true);
		expect(isFileMutatingTool("edit")).toBe(true);
		expect(isFileMutatingTool("read")).toBe(false);
	});

	it("builds readable titles", () => {
		expect(toolTitle(cwd, "read", { path: "src/a.ts" })).toBe("Read src/a.ts");
		expect(toolTitle(cwd, "read", { path: "src/a.ts", offset: 10, limit: 5 })).toBe("Read src/a.ts:10-14");
		expect(toolTitle(cwd, "edit", { path: "/work/src/a.ts", edits: [{}, {}] })).toBe("Edit src/a.ts (2 edits)");
		expect(toolTitle(cwd, "grep", { pattern: "TODO", glob: "*.ts" })).toBe('Search "TODO" in *.ts');
		expect(toolTitle(cwd, "bash", { command: "npm test" })).toBe("npm test");
		expect(toolTitle(cwd, "bash", { command: "npm test\nnpm run lint" })).toBe("npm test …");
	});

	it("degrades to the tool name before arguments arrive", () => {
		expect(toolTitle(cwd, "edit")).toBe("Edit");
		expect(toolTitle(cwd, "mystery")).toBe("mystery");
	});

	it("resolves locations against the session cwd", () => {
		expect(toolLocations(cwd, "read", { path: "src/a.ts", offset: 12 })).toEqual([
			{ path: "/work/src/a.ts", line: 12 },
		]);
		expect(toolLocations(cwd, "bash", { command: "ls" })).toEqual([]);
	});

	it("shows paths outside the cwd in full", () => {
		expect(displayPath(cwd, "/etc/hosts")).toBe("/etc/hosts");
		expect(displayPath(cwd, "src/a.ts")).toBe("src/a.ts");
	});
});

describe("usage", () => {
	const base = {
		sessionId: "s",
		userMessages: 1,
		assistantMessages: 1,
		toolCalls: 0,
		toolResults: 0,
		totalMessages: 2,
		tokens: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, total: 15 },
		cost: 0.25,
	};

	it("reports context occupancy, not cumulative token totals", () => {
		expect(
			toAcpUsageUpdate({ ...base, contextUsage: { tokens: 6_000, contextWindow: 200_000, percent: 3 } }),
		).toEqual({ used: 6_000, size: 200_000, cost: { amount: 0.25, currency: "USD" } });
	});

	it("keeps a zero cost, which is meaningful for local models", () => {
		const update = toAcpUsageUpdate({
			...base,
			cost: 0,
			contextUsage: { tokens: 1, contextWindow: 100, percent: 1 },
		});
		expect(update?.cost).toEqual({ amount: 0, currency: "USD" });
	});

	it("reports nothing when pi has no context figure", () => {
		expect(toAcpUsageUpdate(base)).toBeNull();
		// pi nulls these out between compaction and the next assistant response.
		expect(toAcpUsageUpdate({ ...base, contextUsage: { tokens: null, contextWindow: 200_000, percent: null } })).toBeNull();
		expect(toAcpUsageUpdate({ ...base, contextUsage: { tokens: 10, contextWindow: 0, percent: 0 } })).toBeNull();
	});
});
