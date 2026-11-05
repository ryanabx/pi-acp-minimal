import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	symlinkSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { encodeCwd, PiSessionStore } from "../src/pi/session-store.js";

let root: string;
/** A PATH with no `trash`, so deletion unlinks. */
let emptyBin: string;

beforeEach(() => {
	// Real path: pi records the resolved working directory, and so must the fixtures.
	root = realpathSync(mkdtempSync(path.join(tmpdir(), "pi-acp-store-")));
	emptyBin = path.join(root, "empty-bin");
	mkdirSync(emptyBin);
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

/** Write a pi-format session file. */
function writeSession(
	file: string,
	cwd: string,
	options: { name?: string; firstUser?: string; lastActivity?: number; header?: object } = {},
): string {
	mkdirSync(path.dirname(file), { recursive: true });
	const lines: object[] = [
		options.header ?? { type: "session", version: 3, id: path.basename(file), timestamp: "2026-01-01T00:00:00.000Z", cwd },
	];
	const at = options.lastActivity ?? Date.parse("2026-01-02T00:00:00.000Z");
	if (options.firstUser !== undefined) {
		lines.push({
			type: "message",
			id: "a1",
			parentId: null,
			timestamp: new Date(at).toISOString(),
			message: { role: "user", content: [{ type: "text", text: options.firstUser }], timestamp: at },
		});
	}
	if (options.name !== undefined) {
		lines.push({ type: "session_info", id: "a2", parentId: "a1", timestamp: new Date(at).toISOString(), name: options.name });
	}
	writeFileSync(file, `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`);
	return file;
}

describe("default session layout", () => {
	let agentDir: string;
	let project: string;
	let store: PiSessionStore;

	beforeEach(() => {
		agentDir = path.join(root, "agent");
		project = path.join(root, "project");
		mkdirSync(project);
		store = new PiSessionStore({ piArgs: [], env: { PI_CODING_AGENT_DIR: agentDir, PATH: emptyBin } });
	});

	const sessionsFor = (cwd: string) => path.join(agentDir, "sessions", encodeCwd(cwd));

	it("lists a working directory's sessions, newest first, titled like pi's picker", async () => {
		const older = writeSession(path.join(sessionsFor(project), "1_old.jsonl"), project, {
			firstUser: "fix   the\nbuild",
			lastActivity: Date.parse("2026-01-01T10:00:00Z"),
		});
		const newer = writeSession(path.join(sessionsFor(project), "2_new.jsonl"), project, {
			firstUser: "hello",
			name: "Refactor auth",
			lastActivity: Date.parse("2026-01-03T10:00:00Z"),
		});
		writeSession(path.join(sessionsFor("/elsewhere"), "3.jsonl"), "/elsewhere", { firstUser: "other" });

		expect(await store.list(project)).toEqual([
			{ path: newer, cwd: project, title: "Refactor auth", updatedAt: "2026-01-03T10:00:00.000Z" },
			{ path: older, cwd: project, title: "fix the build", updatedAt: "2026-01-01T10:00:00.000Z" },
		]);
		expect((await store.list()).map((session) => session.cwd).sort()).toEqual(["/elsewhere", project, project]);
	});

	it("finds a symlinked working directory under its real path, as pi records it", async () => {
		const link = path.join(root, "link");
		symlinkSync(project, link);
		writeSession(path.join(sessionsFor(project), "1.jsonl"), project, { firstUser: "hi" });
		expect(await store.list(link)).toHaveLength(1);
	});

	it("skips files that are not pi sessions", async () => {
		mkdirSync(sessionsFor(project), { recursive: true });
		writeFileSync(path.join(sessionsFor(project), "junk.jsonl"), '{"type":"message"}\n');
		writeFileSync(path.join(sessionsFor(project), "empty.jsonl"), "");
		expect(await store.list(project)).toEqual([]);
	});

	it("deletes a stored session", async () => {
		const file = writeSession(path.join(sessionsFor(project), "1.jsonl"), project, { firstUser: "hi" });
		expect(await store.remove(file)).toBe(true);
		expect(existsSync(file)).toBe(false);
	});

	it("uses the trash CLI when it is installed, as pi does", async () => {
		const bin = path.join(root, "bin");
		mkdirSync(bin);
		const record = path.join(root, "trashed.txt");
		writeFileSync(path.join(bin, "trash"), `#!/bin/sh\necho "$1" > "${record}"\nrm -- "$1"\n`);
		chmodSync(path.join(bin, "trash"), 0o755);
		const withTrash = new PiSessionStore({ piArgs: [], env: { PI_CODING_AGENT_DIR: agentDir, PATH: bin } });

		const file = writeSession(path.join(sessionsFor(project), "1.jsonl"), project, { firstUser: "hi" });
		expect(await withTrash.remove(file)).toBe(true);
		expect(readFileSync(record, "utf8").trim()).toBe(file);
	});

	it("refuses to delete anything outside pi's session directory", async () => {
		const outside = writeSession(path.join(root, "elsewhere", "1.jsonl"), project, { firstUser: "hi" });
		const notADirOfSessions = writeSession(path.join(agentDir, "sessions", "1.jsonl"), project, { firstUser: "hi" });
		const notASession = path.join(sessionsFor(project), "notes.jsonl");
		mkdirSync(path.dirname(notASession), { recursive: true });
		writeFileSync(notASession, '{"type":"note"}\n');
		const escaping = path.join(sessionsFor(project), "..", "..", "..", "elsewhere", "1.jsonl");

		for (const file of [outside, notADirOfSessions, notASession, escaping, "relative.jsonl", `${outside}.txt`]) {
			expect(await store.remove(file)).toBe(false);
		}
		expect(existsSync(outside)).toBe(true);
		expect(existsSync(notADirOfSessions)).toBe(true);
		expect(existsSync(notASession)).toBe(true);
	});

	it("refuses a symlink that leads out of the session directory", async () => {
		const outside = writeSession(path.join(root, "elsewhere", "1.jsonl"), project, { firstUser: "hi" });
		mkdirSync(sessionsFor(project), { recursive: true });
		const link = path.join(sessionsFor(project), "link.jsonl");
		symlinkSync(outside, link);
		expect(await store.remove(link)).toBe(false);
		expect(existsSync(outside)).toBe(true);
	});
});

describe("custom session directory", () => {
	let project: string;

	beforeEach(() => {
		project = path.join(root, "project");
		mkdirSync(project);
	});

	it("reads --session-dir from the pi arguments and filters by the header cwd", async () => {
		const dir = path.join(root, "custom");
		const mine = writeSession(path.join(dir, "1.jsonl"), project, { firstUser: "mine" });
		writeSession(path.join(dir, "2.jsonl"), "/somewhere/else", { firstUser: "theirs" });
		const store = new PiSessionStore({ piArgs: ["--model", "x", "--session-dir", dir], env: { PATH: emptyBin } });

		expect((await store.list(project)).map((session) => session.path)).toEqual([mine]);
		expect(await store.list()).toHaveLength(2);
		expect(await store.remove(mine)).toBe(true);
	});

	it("falls back to PI_CODING_AGENT_SESSION_DIR", async () => {
		const dir = path.join(root, "from-env");
		writeSession(path.join(dir, "1.jsonl"), project, { firstUser: "hi" });
		const store = new PiSessionStore({ piArgs: [], env: { PI_CODING_AGENT_SESSION_DIR: dir, PATH: emptyBin } });
		expect(await store.list(project)).toHaveLength(1);
	});

	it("falls back to the sessionDir setting in pi's global settings", async () => {
		const agentDir = path.join(root, "agent");
		const dir = path.join(root, "from-settings");
		mkdirSync(agentDir);
		writeFileSync(path.join(agentDir, "settings.json"), JSON.stringify({ sessionDir: dir }));
		writeSession(path.join(dir, "1.jsonl"), project, { firstUser: "hi" });
		const store = new PiSessionStore({ piArgs: [], env: { PI_CODING_AGENT_DIR: agentDir, PATH: emptyBin } });
		expect(await store.list(project)).toHaveLength(1);
	});

	it("does not read the default layout when a custom directory is set", async () => {
		const agentDir = path.join(root, "agent");
		writeSession(path.join(agentDir, "sessions", encodeCwd(project), "1.jsonl"), project, { firstUser: "hi" });
		const store = new PiSessionStore({
			piArgs: ["--session-dir", path.join(root, "custom")],
			env: { PI_CODING_AGENT_DIR: agentDir, PATH: emptyBin },
		});
		expect(await store.list(project)).toEqual([]);
	});
});

describe("modification time fallback", () => {
	it("uses the header timestamp when there are no messages", async () => {
		const dir = path.join(root, "custom");
		const file = writeSession(path.join(dir, "1.jsonl"), "/p");
		utimesSync(file, new Date("2020-01-01"), new Date("2020-01-01"));
		const store = new PiSessionStore({ piArgs: ["--session-dir", dir], env: { PATH: emptyBin } });
		expect((await store.list())[0]?.updatedAt).toBe("2026-01-01T00:00:00.000Z");
	});
});
