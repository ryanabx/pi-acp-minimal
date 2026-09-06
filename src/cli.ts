#!/usr/bin/env node
import { Readable, Writable } from "node:stream";
import { AgentSideConnection, ndJsonStream } from "@agentclientprotocol/sdk";
import { PiAcpAgent } from "./acp/agent.js";
import { traceStream } from "./acp/wire-trace.js";

const USAGE = `pi-acp-minimal — Agent Client Protocol adapter for the pi coding agent

Usage: pi-acp-minimal [options] [-- <pi arguments>...]

The adapter speaks ACP over stdio and drives \`pi --mode rpc\` under the hood,
so it is meant to be launched by an ACP client (Zed, Neovim, …) rather than by hand.

Options:
  --pi-command <path>   Executable used to launch pi (default: $PI_ACP_PI_COMMAND or "pi")
  --model <pattern>     Passed through to pi as --model
  --provider <name>     Passed through to pi as --provider
  --session-dir <path>  Passed through to pi as --session-dir
  --approve             Passed through to pi as --approve (trust project-local files)
  --quiet               Do not mirror pi's stderr onto this process's stderr
  --log-file <path>     Append every ACP frame, both directions, to a JSONL file
  -h, --help            Show this help

Anything after \`--\` is forwarded verbatim to every pi process.

Example Zed configuration (settings.json):
  "agent_servers": {
    "pi": { "command": "npx", "args": ["-y", "github:ryanabx/pi-acp-minimal#v1.0.0"] }
  }
`;

interface CliOptions {
	piCommand: string;
	piArgs: string[];
	quiet: boolean;
	logFile?: string;
}

export function parseArgs(argv: string[]): CliOptions | { help: true } {
	const options: CliOptions = {
		piCommand: process.env.PI_ACP_PI_COMMAND ?? "pi",
		piArgs: [],
		quiet: false,
		...(process.env.PI_ACP_LOG_FILE ? { logFile: process.env.PI_ACP_LOG_FILE } : {}),
	};

	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i]!;
		const next = () => {
			const value = argv[++i];
			if (value === undefined) throw new Error(`${arg} requires a value`);
			return value;
		};

		switch (arg) {
			case "-h":
			case "--help":
				return { help: true };
			case "--pi-command":
				options.piCommand = next();
				break;
			case "--model":
				options.piArgs.push("--model", next());
				break;
			case "--provider":
				options.piArgs.push("--provider", next());
				break;
			case "--session-dir":
				options.piArgs.push("--session-dir", next());
				break;
			case "--approve":
				options.piArgs.push("--approve");
				break;
			case "--quiet":
				options.quiet = true;
				break;
			case "--log-file":
				options.logFile = next();
				break;
			case "--":
				options.piArgs.push(...argv.slice(i + 1));
				i = argv.length;
				break;
			default:
				throw new Error(`Unknown option: ${arg}`);
		}
	}

	return options;
}

async function main(): Promise<void> {
	let parsed: CliOptions | { help: true };
	try {
		parsed = parseArgs(process.argv.slice(2));
	} catch (error) {
		process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n\n${USAGE}`);
		process.exit(2);
	}

	if ("help" in parsed) {
		process.stdout.write(USAGE);
		return;
	}

	const { piCommand, piArgs, quiet, logFile } = parsed;
	const log = (message: string) => {
		if (!quiet && message) process.stderr.write(`[pi-acp-minimal] ${message}\n`);
	};

	// stdout is the ACP transport; anything else written there corrupts the stream.
	const raw = ndJsonStream(Writable.toWeb(process.stdout), Readable.toWeb(process.stdin));
	const stream = logFile ? traceStream(raw, logFile) : raw;

	let agent: PiAcpAgent | undefined;
	new AgentSideConnection((connection) => {
		agent = new PiAcpAgent(connection, { piCommand, piArgs, log });
		return agent;
	}, stream);

	const shutdown = async () => {
		await agent?.shutdown();
		process.exit(0);
	};
	process.on("SIGINT", () => void shutdown());
	process.on("SIGTERM", () => void shutdown());
	process.stdin.on("end", () => void shutdown());
}

main().catch((error: unknown) => {
	process.stderr.write(`[pi-acp-minimal] fatal: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`);
	process.exit(1);
});
