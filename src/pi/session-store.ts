import { execFile } from "node:child_process";
import { createReadStream } from "node:fs";
import { readdir, readFile, realpath, stat, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { findOnPath } from "./find-executable.js";
import { attachJsonlLineReader } from "./jsonl.js";

/**
 * Read-only view of pi's stored sessions, plus deletion.
 *
 * pi's RPC protocol has no command for listing or deleting sessions, so this
 * reads pi's session files directly, following pi's own rules (see
 * `SessionManager.list` and `docs/session-format.md`):
 *
 * - The session directory is `--session-dir`, else `PI_CODING_AGENT_SESSION_DIR`,
 *   else the `sessionDir` setting in pi's global `settings.json`, else the
 *   default layout under `<agent dir>/sessions/`.
 * - The default layout keeps each working directory's sessions in its own
 *   `--<encoded cwd>--` subdirectory. A custom directory is flat, and its
 *   sessions are matched to a working directory by their header's `cwd`.
 * - A session file is JSONL whose first record is a `session` header.
 *
 * A project-level `sessionDir` setting (`.pi/settings.json`) is not honoured:
 * pi only reads it for trusted projects, which the adapter cannot tell.
 */
export interface StoredSession {
	/** Absolute path of the session file, which is also the ACP session id. */
	path: string;
	cwd: string;
	/** pi's session name, else the start of the first user message. */
	title?: string;
	/** ISO 8601 time of the last user or assistant message. */
	updatedAt?: string;
}

export interface PiSessionStoreOptions {
	/** Arguments passed to every pi process; `--session-dir` is read from them. */
	piArgs: string[];
	env: NodeJS.ProcessEnv;
}

const TITLE_LENGTH = 120;
const SESSION_DIR_PATTERN = /^--.*--$/;
const run = promisify(execFile);

export class PiSessionStore {
	readonly #piArgs: string[];
	readonly #env: NodeJS.ProcessEnv;

	constructor(options: PiSessionStoreOptions) {
		this.#piArgs = options.piArgs;
		this.#env = options.env;
	}

	/**
	 * Stored sessions, most recently active first.
	 *
	 * With `cwd`, only sessions that ran in that directory; without it, all of them.
	 */
	async list(cwd?: string): Promise<StoredSession[]> {
		const baseDir = cwd ?? process.cwd();
		const custom = await this.#customDir(baseDir);
		const realCwd = cwd === undefined ? undefined : await realPathOr(cwd);

		let files: string[];
		if (custom) {
			files = await jsonlFiles(custom);
		} else if (realCwd !== undefined) {
			files = await jsonlFiles(path.join(this.#defaultRoot(), encodeCwd(realCwd)));
		} else {
			const root = this.#defaultRoot();
			const dirs = (await readdirSafe(root)).filter((name) => SESSION_DIR_PATTERN.test(name));
			files = (await Promise.all(dirs.map((name) => jsonlFiles(path.join(root, name))))).flat();
		}

		const sessions = (await Promise.all(files.map((file) => readSessionInfo(file)))).filter(
			(session): session is StoredSession => session !== null,
		);
		// A custom directory mixes every working directory's sessions.
		const matching =
			custom && realCwd !== undefined
				? (
						await Promise.all(
							sessions.map(async (session) => ((await realPathOr(session.cwd)) === realCwd ? session : null)),
						)
					).filter((session): session is StoredSession => session !== null)
				: sessions;

		return matching.sort((a, b) => (b.updatedAt ?? "").localeCompare(a.updatedAt ?? ""));
	}

	/**
	 * Delete a stored session file, the way pi's `/resume` picker does: through
	 * the `trash` CLI when it is installed, else permanently.
	 *
	 * Refuses anything that is not a pi session file inside pi's session
	 * directory, since the path comes from the client.
	 *
	 * @returns false when there is no such session.
	 */
	async remove(sessionFile: string): Promise<boolean> {
		if (!(await this.isStoredSession(sessionFile))) return false;
		// Not on Windows, where a `trash` npm shim is a .cmd that execFile cannot run.
		const trash = process.platform === "win32" ? null : findOnPath("trash", this.#env);
		if (trash) {
			await run(trash, [sessionFile]);
		} else {
			await unlink(sessionFile);
		}
		return true;
	}

	/** Whether `sessionFile` is a pi session file inside pi's session directory. */
	async isStoredSession(sessionFile: string): Promise<boolean> {
		if (!path.isAbsolute(sessionFile) || !sessionFile.endsWith(".jsonl")) return false;
		let real: string;
		try {
			real = await realpath(sessionFile);
		} catch {
			return false;
		}

		const parent = path.dirname(real);
		const custom = await this.#customDir(process.cwd());
		const defaultRoot = await realPathOr(this.#defaultRoot());
		const inCustom = custom !== undefined && parent === (await realPathOr(custom));
		const inDefault = path.dirname(parent) === defaultRoot && SESSION_DIR_PATTERN.test(path.basename(parent));
		if (!inCustom && !inDefault) return false;

		return (await readSessionInfo(real)) !== null;
	}

	/** `<agent dir>/sessions`, pi's default session root. */
	#defaultRoot(): string {
		return path.join(this.#agentDir(), "sessions");
	}

	#agentDir(): string {
		const fromEnv = this.#env.PI_CODING_AGENT_DIR;
		return fromEnv ? expandTilde(fromEnv) : path.join(homedir(), ".pi", "agent");
	}

	/** The custom session directory pi would use for a process started in `cwd`, if any. */
	async #customDir(cwd: string): Promise<string | undefined> {
		const fromArgs = lastFlagValue(this.#piArgs, "--session-dir");
		if (fromArgs) return path.resolve(cwd, expandTilde(fromArgs));

		const fromEnv = this.#env.PI_CODING_AGENT_SESSION_DIR;
		if (fromEnv) return path.resolve(cwd, expandTilde(fromEnv));

		try {
			const settings = JSON.parse(await readFile(path.join(this.#agentDir(), "settings.json"), "utf8")) as unknown;
			const sessionDir = (settings as { sessionDir?: unknown } | null)?.sessionDir;
			if (typeof sessionDir === "string" && sessionDir) return path.resolve(cwd, expandTilde(sessionDir));
		} catch {
			// No settings file, or not JSON: pi falls back to the default layout too.
		}
		return undefined;
	}
}

/** pi's default per-cwd directory name: `/a/b` -> `--a-b--`. */
export function encodeCwd(cwd: string): string {
	return `--${cwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
}

/**
 * Summarise one session file, or `null` if it is not a pi session.
 *
 * Mirrors pi's session picker: the name is the latest `session_info` entry,
 * the fallback title the first user message, and the activity time the
 * latest user or assistant message.
 */
async function readSessionInfo(file: string): Promise<StoredSession | null> {
	let header: { cwd?: unknown; timestamp?: unknown } | null = null;
	let valid = true;
	let name: string | undefined;
	let firstUserText: string | undefined;
	let lastActivity: number | undefined;

	const stream = createReadStream(file);
	await new Promise<void>((resolve) => {
		const detach = attachJsonlLineReader(stream, (line) => {
			if (!valid) return;
			let entry: Record<string, unknown>;
			try {
				entry = JSON.parse(line) as Record<string, unknown>;
			} catch {
				return;
			}
			if (!header) {
				if (entry.type !== "session") {
					valid = false;
					stream.destroy();
					return;
				}
				header = entry;
				return;
			}
			if (entry.type === "session_info") {
				name = typeof entry.name === "string" && entry.name.trim() ? entry.name.trim() : undefined;
				return;
			}
			if (entry.type !== "message") return;
			const message = entry.message as { role?: unknown; content?: unknown; timestamp?: unknown } | undefined;
			if (message?.role !== "user" && message?.role !== "assistant") return;
			const time = typeof message.timestamp === "number" ? message.timestamp : Date.parse(String(entry.timestamp));
			if (!Number.isNaN(time)) lastActivity = Math.max(lastActivity ?? 0, time);
			if (firstUserText === undefined && message.role === "user") {
				const text = messageText(message.content);
				if (text) firstUserText = text;
			}
		});
		const done = () => {
			detach();
			resolve();
		};
		stream.once("end", done);
		stream.once("close", done);
		stream.once("error", () => {
			valid = false;
			done();
		});
	});

	const sessionHeader = header as { cwd?: unknown; timestamp?: unknown } | null;
	if (!valid || !sessionHeader) return null;

	const headerTime = typeof sessionHeader.timestamp === "string" ? Date.parse(sessionHeader.timestamp) : Number.NaN;
	let updated = lastActivity ?? (Number.isNaN(headerTime) ? undefined : headerTime);
	if (updated === undefined) {
		try {
			updated = (await stat(file)).mtimeMs;
		} catch {
			// Leave it unknown.
		}
	}

	const title = name ?? (firstUserText ? oneLine(firstUserText) : undefined);
	return {
		path: file,
		cwd: typeof sessionHeader.cwd === "string" ? sessionHeader.cwd : "",
		...(title ? { title } : {}),
		...(updated === undefined ? {} : { updatedAt: new Date(updated).toISOString() }),
	};
}

function messageText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter((block): block is { type: "text"; text: string } => block?.type === "text" && typeof block.text === "string")
		.map((block) => block.text)
		.join(" ");
}

function oneLine(text: string): string {
	const flat = text.replace(/\s+/g, " ").trim();
	return flat.length > TITLE_LENGTH ? `${flat.slice(0, TITLE_LENGTH - 1)}…` : flat;
}

function lastFlagValue(args: string[], flag: string): string | undefined {
	let value: string | undefined;
	for (let i = 0; i < args.length; i++) {
		const arg = args[i]!;
		if (arg === flag && i + 1 < args.length) value = args[++i];
		else if (arg.startsWith(`${flag}=`)) value = arg.slice(flag.length + 1);
	}
	return value;
}

function expandTilde(value: string): string {
	if (value === "~") return homedir();
	if (value.startsWith("~/")) return path.join(homedir(), value.slice(2));
	return value;
}

async function realPathOr(value: string): Promise<string> {
	try {
		return await realpath(value);
	} catch {
		return path.resolve(value);
	}
}

async function readdirSafe(dir: string): Promise<string[]> {
	try {
		return await readdir(dir);
	} catch {
		return [];
	}
}

async function jsonlFiles(dir: string): Promise<string[]> {
	return (await readdirSafe(dir)).filter((name) => name.endsWith(".jsonl")).map((name) => path.join(dir, name));
}
