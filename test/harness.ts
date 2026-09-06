import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { StringDecoder } from "node:string_decoder";
import { fileURLToPath } from "node:url";
import type {
	InitializeRequest,
	InitializeResponse,
	LoadSessionRequest,
	LoadSessionResponse,
	NewSessionRequest,
	NewSessionResponse,
	PromptRequest,
	PromptResponse,
	RequestPermissionRequest,
	SessionNotification,
} from "@agentclientprotocol/sdk";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..");
const MOCK_PI = path.join(here, "mock-pi.mjs");

export type Update = SessionNotification["update"];

interface JsonRpcMessage {
	jsonrpc: "2.0";
	id?: number | string;
	method?: string;
	params?: unknown;
	result?: unknown;
	error?: { code: number; message: string; data?: unknown };
}

/** JSON-RPC error surfaced by the adapter. */
export class AdapterError extends Error {
	constructor(
		readonly code: number,
		message: string,
		readonly data?: unknown,
	) {
		super(message);
		this.name = "AdapterError";
	}
}

/**
 * An ACP client that drives the real `pi-acp-minimal` process over stdio.
 *
 * Hand-rolled rather than built on `ClientSideConnection` so tests assert the
 * exact wire methods the adapter serves. (v0.4.5 of the library also sends
 * `session/set_mode` from `setSessionModel`, which would make that untestable.)
 */
export class TestClient {
	readonly updates: Update[] = [];
	readonly permissionRequests: RequestPermissionRequest[] = [];
	readonly stderr: string[] = [];
	/** Option id used to answer the next permission request; `null` cancels. */
	permissionAnswer: string | null = null;
	/** Files the adapter may read through `fs/read_text_file`, when enabled. */
	readonly clientFiles = new Map<string, string>();
	clientFsEnabled = false;

	readonly workspace: string;

	#process: ChildProcessWithoutNullStreams;
	#nextId = 0;
	#pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
	#waiters: Array<{ predicate: (updates: Update[]) => boolean; resolve: () => void; reject: (e: Error) => void }> = [];

	/** Called synchronously as each `session/update` arrives, for ordering checks. */
	onUpdate?: (update: Update) => void;

	constructor(options: { workspace: string; piCommand?: string; extraArgs?: string[]; env?: NodeJS.ProcessEnv }) {
		this.workspace = options.workspace;
		this.#process = spawn(
			"node",
			[
				path.join(repoRoot, "node_modules/tsx/dist/cli.mjs"),
				path.join(repoRoot, "src/cli.ts"),
				"--pi-command",
				options.piCommand ?? MOCK_PI,
				...(options.extraArgs ?? []),
			],
			{
				cwd: repoRoot,
				stdio: ["pipe", "pipe", "pipe"],
				env: { ...process.env, MOCK_PI_SESSION_DIR: options.workspace, ...options.env },
			},
		);

		this.#process.stderr.setEncoding("utf8");
		this.#process.stderr.on("data", (chunk: string) => this.stderr.push(chunk));

		const decoder = new StringDecoder("utf8");
		let buffer = "";
		this.#process.stdout.on("data", (chunk: Buffer) => {
			buffer += decoder.write(chunk);
			let index: number;
			while ((index = buffer.indexOf("\n")) !== -1) {
				const line = buffer.slice(0, index);
				buffer = buffer.slice(index + 1);
				if (line.trim()) this.#handle(JSON.parse(line) as JsonRpcMessage);
			}
		});
	}

	// --------------------------------------------------------------------------
	// Agent methods
	// --------------------------------------------------------------------------

	initialize(params: InitializeRequest): Promise<InitializeResponse> {
		return this.request("initialize", params);
	}

	newSession(params: NewSessionRequest): Promise<NewSessionResponse> {
		return this.request("session/new", params);
	}

	loadSession(params: LoadSessionRequest): Promise<LoadSessionResponse> {
		return this.request("session/load", params);
	}

	prompt(params: PromptRequest): Promise<PromptResponse> {
		return this.request("session/prompt", params);
	}

	setConfigOption(sessionId: string, configId: string, value: string | boolean): Promise<{ configOptions: unknown[] }> {
		return this.request("session/set_config_option", { sessionId, configId, value });
	}

	cancel(sessionId: string): void {
		this.#write({ jsonrpc: "2.0", method: "session/cancel", params: { sessionId } });
	}

	request<T>(method: string, params: unknown): Promise<T> {
		const id = ++this.#nextId;
		return new Promise<T>((resolve, reject) => {
			this.#pending.set(id, { resolve: resolve as (value: unknown) => void, reject });
			this.#write({ jsonrpc: "2.0", id, method, params });
		});
	}

	// --------------------------------------------------------------------------
	// Assertions helpers
	// --------------------------------------------------------------------------

	async waitFor(predicate: (updates: Update[]) => boolean, timeoutMs = 10_000): Promise<void> {
		if (predicate(this.updates)) return;
		await new Promise<void>((resolve, reject) => {
			const timer = setTimeout(() => reject(new Error("timed out waiting for session updates")), timeoutMs);
			this.#waiters.push({
				predicate,
				resolve: () => {
					clearTimeout(timer);
					resolve();
				},
				reject: (error) => {
					clearTimeout(timer);
					reject(error);
				},
			});
		});
	}

	agentText(): string {
		return this.#chunkText("agent_message_chunk");
	}

	thoughtText(): string {
		return this.#chunkText("agent_thought_chunk");
	}

	userText(): string {
		return this.#chunkText("user_message_chunk");
	}

	toolUpdates(toolCallId: string): Update[] {
		return this.updates.filter(
			(update) =>
				(update.sessionUpdate === "tool_call" || update.sessionUpdate === "tool_call_update") &&
				update.toolCallId === toolCallId,
		);
	}

	close(): void {
		for (const waiter of this.#waiters) waiter.reject(new Error("client closed"));
		this.#waiters = [];
		this.#process.kill("SIGKILL");
	}

	#chunkText(kind: "agent_message_chunk" | "agent_thought_chunk" | "user_message_chunk"): string {
		let text = "";
		for (const update of this.updates) {
			if (update.sessionUpdate === kind && update.content.type === "text") text += update.content.text;
		}
		return text;
	}

	// --------------------------------------------------------------------------
	// Transport
	// --------------------------------------------------------------------------

	#write(message: JsonRpcMessage): void {
		this.#process.stdin.write(`${JSON.stringify(message)}\n`);
	}

	#handle(message: JsonRpcMessage): void {
		if (message.method !== undefined) return void this.#handleIncoming(message);

		const id = message.id;
		if (typeof id !== "number") return;
		const pending = this.#pending.get(id);
		if (!pending) return;
		this.#pending.delete(id);
		if (message.error) {
			pending.reject(new AdapterError(message.error.code, message.error.message, message.error.data));
		} else {
			pending.resolve(message.result);
		}
	}

	async #handleIncoming(message: JsonRpcMessage): Promise<void> {
		const respond = (result: unknown) => {
			if (message.id !== undefined) this.#write({ jsonrpc: "2.0", id: message.id, result });
		};

		switch (message.method) {
			case "session/update": {
				const params = message.params as SessionNotification;
				this.updates.push(params.update);
				this.onUpdate?.(params.update);
				for (const waiter of [...this.#waiters]) {
					if (waiter.predicate(this.updates)) {
						this.#waiters.splice(this.#waiters.indexOf(waiter), 1);
						waiter.resolve();
					}
				}
				return;
			}
			case "session/request_permission": {
				const params = message.params as RequestPermissionRequest;
				this.permissionRequests.push(params);
				respond(
					this.permissionAnswer === null
						? { outcome: { outcome: "cancelled" } }
						: { outcome: { outcome: "selected", optionId: this.permissionAnswer } },
				);
				return;
			}
			case "fs/read_text_file": {
				const params = message.params as { path: string };
				const content = this.clientFiles.get(params.path);
				if (!this.clientFsEnabled || content === undefined) {
					if (message.id !== undefined) {
						this.#write({
							jsonrpc: "2.0",
							id: message.id,
							error: { code: -32002, message: "Resource not found" },
						});
					}
					return;
				}
				respond({ content });
				return;
			}
			default:
				respond({});
		}
	}
}

/** Temporary workspace plus a connected client; the caller runs `cleanup`. */
export function createTestClient(options: { piCommand?: string; extraArgs?: string[]; env?: NodeJS.ProcessEnv } = {}): {
	client: TestClient;
	workspace: string;
	cleanup: () => void;
} {
	const workspace = mkdtempSync(path.join(tmpdir(), "pi-acp-minimal-test-"));
	const client = new TestClient({ workspace, ...options });
	return {
		client,
		workspace,
		cleanup: () => {
			client.close();
			rmSync(workspace, { recursive: true, force: true });
		},
	};
}
