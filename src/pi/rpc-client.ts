import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { attachJsonlLineReader, serializeJsonLine } from "./jsonl.js";
import type {
	PiExtensionUiRequest,
	PiExtensionUiResponse,
	PiRpcCommand,
	PiRpcCommandType,
	PiRpcEvent,
	PiRpcResponse,
	PiRpcResponseData,
	PiStdoutMessage,
} from "./rpc-types.js";

export interface PiRpcClientOptions {
	/** Executable to run. Defaults to `pi`. */
	command?: string;
	/** Arguments inserted before the adapter's own `--mode rpc`. */
	args?: string[];
	cwd: string;
	env?: NodeJS.ProcessEnv;
	/** Called for every agent event pi emits. */
	onEvent: (event: PiRpcEvent) => void;
	/** Called for every extension UI request pi emits. */
	onExtensionUiRequest: (request: PiExtensionUiRequest) => void;
	/** Called once when the pi process exits unexpectedly. */
	onExit?: (info: { code: number | null; signal: NodeJS.Signals | null; stderr: string }) => void;
	/** Receives pi's stderr, line-buffered, for logging. */
	onStderr?: (chunk: string) => void;
}

/** Thrown when pi answers a command with `success: false`. */
export class PiRpcError extends Error {
	constructor(
		readonly command: string,
		message: string,
	) {
		super(message);
		this.name = "PiRpcError";
	}
}

const STDERR_TAIL_LIMIT = 8_000;

/**
 * A JSONL client for one `pi --mode rpc` child process.
 *
 * Owns request/response correlation via the protocol's `id` field and fans
 * events and extension UI requests out to the caller.
 */
export class PiRpcClient {
	#process: ChildProcessWithoutNullStreams | null = null;
	#detachStdout: (() => void) | null = null;
	#pending = new Map<string, { resolve: (r: PiRpcResponse) => void; reject: (e: Error) => void }>();
	#nextId = 0;
	#stderrTail = "";
	#exitError: Error | null = null;
	#stopping = false;
	#options: PiRpcClientOptions;

	constructor(options: PiRpcClientOptions) {
		this.#options = options;
	}

	get running(): boolean {
		return this.#process !== null && this.#process.exitCode === null;
	}

	get stderrTail(): string {
		return this.#stderrTail;
	}

	start(): void {
		if (this.#process) throw new Error("pi RPC client already started");

		const command = this.#options.command ?? "pi";
		const args = [...(this.#options.args ?? []), "--mode", "rpc"];

		const child = spawn(command, args, {
			cwd: this.#options.cwd,
			env: this.#options.env ?? process.env,
			stdio: ["pipe", "pipe", "pipe"],
		});
		this.#process = child;

		child.stderr.setEncoding("utf8");
		child.stderr.on("data", (chunk: string) => {
			this.#stderrTail = (this.#stderrTail + chunk).slice(-STDERR_TAIL_LIMIT);
			this.#options.onStderr?.(chunk);
		});

		this.#detachStdout = attachJsonlLineReader(child.stdout, (line) => this.#handleLine(line));

		child.once("error", (error) => this.#fail(new Error(`Failed to run \`${command}\`: ${error.message}`)));
		child.once("exit", (code, signal) => {
			// A deliberate stop() is not an unexpected exit.
			if (!this.#stopping) this.#options.onExit?.({ code, signal, stderr: this.#stderrTail });
			this.#fail(
				new Error(
					`pi exited (code ${code ?? "null"}, signal ${signal ?? "null"})` +
						(this.#stderrTail ? `\n${this.#stderrTail}` : ""),
				),
			);
		});
		// stdin EPIPE is reported through the exit handler; swallow it here.
		child.stdin.on("error", () => {});
	}

	/** Send a command and resolve with its typed `data` payload. */
	async request<T extends PiRpcCommandType>(
		command: Extract<PiRpcCommand, { type: T }>,
	): Promise<PiRpcResponseData[T]> {
		const response = await this.#send(command);
		if (!response.success) throw new PiRpcError(command.type, response.error);
		return response.data as PiRpcResponseData[T];
	}

	/** Reply to a pi extension UI dialog request. */
	respondExtensionUi(response: PiExtensionUiResponse): void {
		this.#write(response);
	}

	async stop(): Promise<void> {
		const child = this.#process;
		if (!child) return;
		this.#stopping = true;
		this.#detachStdout?.();
		this.#detachStdout = null;
		this.#process = null;

		if (child.exitCode === null) {
			child.stdin.end();
			await new Promise<void>((resolve) => {
				const timer = setTimeout(() => {
					child.kill("SIGKILL");
					resolve();
				}, 2_000);
				child.once("exit", () => {
					clearTimeout(timer);
					resolve();
				});
				child.kill("SIGTERM");
			});
		}
		this.#fail(new Error("pi RPC client stopped"));
	}

	#send(command: PiRpcCommand): Promise<PiRpcResponse> {
		if (this.#exitError) return Promise.reject(this.#exitError);
		const child = this.#process;
		if (!child) return Promise.reject(new Error("pi RPC client not started"));

		const id = `acp-${++this.#nextId}`;
		return new Promise<PiRpcResponse>((resolve, reject) => {
			this.#pending.set(id, { resolve, reject });
			try {
				this.#write({ ...command, id });
			} catch (error) {
				this.#pending.delete(id);
				reject(error instanceof Error ? error : new Error(String(error)));
			}
		});
	}

	#write(value: unknown): void {
		const child = this.#process;
		if (!child) throw this.#exitError ?? new Error("pi RPC client not started");
		child.stdin.write(serializeJsonLine(value));
	}

	#handleLine(line: string): void {
		if (!line.trim()) return;

		let message: PiStdoutMessage;
		try {
			message = JSON.parse(line) as PiStdoutMessage;
		} catch {
			// pi guarantees JSONL on stdout; anything else is stray output worth surfacing.
			this.#options.onStderr?.(`[pi-acp-minimal] unparsable line on pi stdout: ${line}\n`);
			return;
		}

		if (message.type === "response") {
			const id = message.id;
			const pending = id === undefined ? undefined : this.#pending.get(id);
			if (pending && id !== undefined) {
				this.#pending.delete(id);
				pending.resolve(message);
			}
			return;
		}

		if (message.type === "extension_ui_request") {
			this.#options.onExtensionUiRequest(message);
			return;
		}

		this.#options.onEvent(message);
	}

	#fail(error: Error): void {
		if (!this.#exitError) this.#exitError = error;
		const pending = [...this.#pending.values()];
		this.#pending.clear();
		for (const entry of pending) entry.reject(error);
	}
}
