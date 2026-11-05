import { readFileSync } from "node:fs";
import {
	type AgentApp,
	agent as agentApp,
	type AuthenticateRequest,
	type CancelNotification,
	type CloseSessionRequest,
	type DeleteSessionRequest,
	type InitializeRequest,
	type InitializeResponse,
	type ListSessionsRequest,
	type ListSessionsResponse,
	type McpServer,
	type LoadSessionRequest,
	type LoadSessionResponse,
	methods,
	type NewSessionRequest,
	type NewSessionResponse,
	PROTOCOL_VERSION,
	type PromptRequest,
	type PromptResponse,
	RequestError,
	type ResumeSessionRequest,
	type ResumeSessionResponse,
	type SetSessionConfigOptionRequest,
	type SetSessionConfigOptionResponse,
} from "@agentclientprotocol/sdk";
import { isThinkingLevel, MODEL_CONFIG_ID, THINKING_CONFIG_ID } from "../map/config.js";
import { toPiPrompt } from "../map/content.js";
import { toPiMcpServers } from "../map/mcp.js";
import { PiRpcError } from "../pi/rpc-client.js";
import { PiSessionStore } from "../pi/session-store.js";
import { type ClientPort, V1ClientPort } from "./client-port.js";
import { authRequired, internalError, invalidParams, resourceNotFound } from "./errors.js";
import { errorMessage, PiSession, UNPERSISTED_SESSION_PREFIX } from "./session.js";

export interface PiAcpAgentOptions {
	/** Executable used to launch pi; when omitted, `pi` is located on `PATH`. */
	piCommand?: string;
	/** Extra arguments passed to every `pi --mode rpc` process. */
	piArgs: string[];
	env?: NodeJS.ProcessEnv;
	log: (message: string) => void;
}

/** This package's own name and version, reported to the client as `agentInfo`. */
const PACKAGE: { name: string; version: string } = JSON.parse(
	readFileSync(new URL("../../package.json", import.meta.url), "utf8"),
);

/**
 * An ACP agent app that serves pi over one connection, plus a hook to stop
 * every pi process it started.
 *
 * Over stdio there is exactly one connection. A server that accepts several
 * should build one app per connection (for example from a `createAgent`
 * factory): the app owns that connection's sessions. Every method the adapter
 * supports is registered explicitly, so the SDK answers anything else with
 * Method Not Found.
 */
export function createPiAgentApp(options: PiAcpAgentOptions): { app: AgentApp; shutdown: () => Promise<void> } {
	let agent: PiAcpAgent | undefined;
	let port: V1ClientPort | undefined;
	const connected = (): PiAcpAgent => {
		if (!agent) throw internalError("ACP connection is not set up");
		return agent;
	};

	const app = agentApp({ name: PACKAGE.name })
		.onConnect((connection) => {
			// onConnect runs before the connection handles its first message.
			if (agent) throw new Error("createPiAgentApp serves a single connection; build one app per connection");
			port = new V1ClientPort(connection.client, undefined);
			const current = new PiAcpAgent(port, options);
			agent = current;
			void connection.closed.then(() => current.shutdown());
		})
		.onRequest(methods.agent.initialize, ({ params }) => {
			if (port) port.capabilities = params.clientCapabilities;
			return connected().initialize(params);
		})
		.onRequest(methods.agent.authenticate, ({ params }) => connected().authenticate(params))
		.onRequest(methods.agent.session.new, ({ params }) => connected().newSession(params))
		.onRequest(methods.agent.session.load, ({ params }) => connected().loadSession(params))
		.onRequest(methods.agent.session.resume, ({ params }) => connected().resumeSession(params))
		.onRequest(methods.agent.session.close, ({ params }) => connected().closeSession(params))
		.onRequest(methods.agent.session.list, ({ params }) => connected().listSessions(params))
		.onRequest(methods.agent.session.delete, ({ params }) => connected().deleteSession(params))
		.onRequest(methods.agent.session.setConfigOption, ({ params }) => connected().setSessionConfigOption(params))
		.onRequest(methods.agent.session.prompt, ({ params }) => connected().prompt(params))
		.onNotification(methods.agent.session.cancel, ({ params }) => connected().cancel(params));

	return { app, shutdown: async () => agent?.shutdown() };
}

/**
 * ACP agent backed by `pi --mode rpc`.
 *
 * Each ACP session owns one pi child process rooted at the session's cwd, which
 * is also how per-session working directories, settings and extensions are honoured.
 */
export class PiAcpAgent {
	#client: ClientPort;
	#options: PiAcpAgentOptions;
	#sessions = new Map<string, PiSession>();
	#store: PiSessionStore;

	constructor(client: ClientPort, options: PiAcpAgentOptions) {
		this.#client = client;
		this.#options = options;
		this.#store = new PiSessionStore({ piArgs: options.piArgs, env: options.env ?? process.env });
	}

	async initialize(params: InitializeRequest): Promise<InitializeResponse> {
		return {
			protocolVersion: Math.min(params.protocolVersion, PROTOCOL_VERSION),
			agentInfo: { name: PACKAGE.name, title: "pi", version: PACKAGE.version },
			agentCapabilities: {
				loadSession: true,
				promptCapabilities: { image: true, embeddedContext: true, audio: false },
				// Client-supplied servers are registered through a pi extension;
				// pi speaks stdio and streamable HTTP, not the legacy SSE transport.
				mcpCapabilities: { http: true, sse: false },
				sessionCapabilities: { list: {}, delete: {}, resume: {}, close: {} },
			},
			// pi manages provider credentials itself (`pi auth login`), so there is
			// nothing for the client to authenticate against.
			authMethods: [],
		};
	}

	async authenticate(_params: AuthenticateRequest): Promise<void> {
		throw authRequired("pi manages its own provider credentials. Run `pi auth login` in a terminal, then retry.");
	}

	async newSession(params: NewSessionRequest): Promise<NewSessionResponse> {
		const session = await this.#startSession(params.cwd, { mcpServers: params.mcpServers });
		// Commands are published only after this response is on the wire: a client
		// cannot route a session/update for a session it has not been told about yet.
		session.publishSessionStateSoon();
		return { sessionId: session.sessionId, configOptions: session.configOptions() };
	}

	async loadSession(params: LoadSessionRequest): Promise<LoadSessionResponse> {
		const session = await this.#openStoredSession(params);
		// session/load streams history while the request is in flight: the client
		// already knows this session id because it supplied it.
		await session.replayHistory();
		await session.publishSessionInfo();
		await session.publishCommands();
		return { configOptions: session.configOptions() };
	}

	/** Like `session/load`, but the client already has the transcript: no replay. */
	async resumeSession(params: ResumeSessionRequest): Promise<ResumeSessionResponse> {
		const session = await this.#openStoredSession(params);
		session.publishSessionStateSoon();
		return { configOptions: session.configOptions() };
	}

	/** pi's stored sessions, newest first, in pages of {@link LIST_PAGE_SIZE}. */
	async listSessions(params: ListSessionsRequest): Promise<ListSessionsResponse> {
		const offset = decodeCursor(params.cursor);
		const sessions = await this.#store.list(params.cwd ?? undefined);
		const page = sessions.slice(offset, offset + LIST_PAGE_SIZE);
		const next = offset + LIST_PAGE_SIZE;
		return {
			sessions: page.map((session) => ({
				sessionId: session.path,
				cwd: session.cwd,
				...(session.title ? { title: session.title } : {}),
				...(session.updatedAt ? { updatedAt: session.updatedAt } : {}),
			})),
			...(next < sessions.length ? { nextCursor: encodeCursor(next) } : {}),
		};
	}

	/** Remove a stored session from disk, stopping it first if it is open. */
	async deleteSession(params: DeleteSessionRequest): Promise<void> {
		if (!(await this.#store.isStoredSession(params.sessionId))) {
			throw resourceNotFound(`No stored pi session: ${params.sessionId}`);
		}
		const running = this.#sessions.get(params.sessionId);
		this.#sessions.delete(params.sessionId);
		await running?.close();
		if (!(await this.#store.remove(params.sessionId))) {
			throw resourceNotFound(`No stored pi session: ${params.sessionId}`);
		}
	}

	/** Cancel any running turn and stop the session's pi process. */
	async closeSession(params: CloseSessionRequest): Promise<void> {
		const session = this.#session(params.sessionId);
		this.#sessions.delete(params.sessionId);
		await session.close();
	}

	/** Start pi on a stored session file, replacing any live process for it. */
	async #openStoredSession(params: {
		sessionId: string;
		cwd: string;
		mcpServers?: McpServer[] | undefined;
	}): Promise<PiSession> {
		if (params.sessionId.startsWith(UNPERSISTED_SESSION_PREFIX)) {
			throw invalidParams("This session was created without persistence and cannot be reopened");
		}

		const running = this.#sessions.get(params.sessionId);
		this.#sessions.delete(params.sessionId);
		await running?.close();

		const session = await this.#startSession(params.cwd, {
			resumeSessionFile: params.sessionId,
			mcpServers: params.mcpServers,
		});
		if (session.sessionId !== params.sessionId) {
			// pi resolved `--session` to a different file; the client only knows the
			// id it asked for, so keep that one authoritative everywhere.
			this.#sessions.delete(session.sessionId);
			session.adoptSessionId(params.sessionId);
			this.#sessions.set(params.sessionId, session);
		}
		return session;
	}

	async setSessionConfigOption(params: SetSessionConfigOptionRequest): Promise<SetSessionConfigOptionResponse> {
		const session = this.#session(params.sessionId);
		const value = "value" in params ? params.value : undefined;
		if (typeof value !== "string") {
			throw invalidParams(`Config option "${params.configId}" expects a string value`);
		}

		try {
			switch (params.configId) {
				case MODEL_CONFIG_ID:
					await session.setModel(value);
					break;
				case THINKING_CONFIG_ID: {
					if (!isThinkingLevel(value)) throw invalidParams(`Unknown thinking level "${value}"`);
					// No pre-check against the model's supported levels: pi owns that
					// decision, and the refreshed options report whatever it settled on.
					const applied = await session.setThinkingLevel(value);
					if (applied !== value) {
						this.#options.log(`pi clamped thinking level "${value}" to "${applied}" for the current model`);
					}
					break;
				}
				default:
					throw invalidParams(`Unknown config option "${params.configId}"`);
			}
		} catch (error) {
			throw toRequestError(error);
		}

		// Returning the refreshed list is how the client learns that, for example,
		// switching models changed which thinking levels exist.
		return { configOptions: session.acknowledgeConfigOptions() };
	}

	/** See {@link PiSession.prompt} for `onInserted`. */
	async prompt(
		params: PromptRequest,
		hooks: { onInserted?: (messageId: string) => void } = {},
	): Promise<PromptResponse> {
		const session = this.#session(params.sessionId);
		const { message, images } = toPiPrompt(params.prompt);
		if (!message && images.length === 0) throw invalidParams("Prompt is empty");

		const stopReason = await session.prompt(message, images, hooks);
		return { stopReason };
	}

	async cancel(params: CancelNotification): Promise<void> {
		await this.#sessions.get(params.sessionId)?.cancel();
	}

	/** Shut every pi child process down; used when the ACP connection closes. */
	async shutdown(): Promise<void> {
		const sessions = [...this.#sessions.values()];
		this.#sessions.clear();
		await Promise.all(sessions.map((session) => session.close()));
	}

	async #startSession(
		cwd: string,
		{ resumeSessionFile, mcpServers = [] }: { resumeSessionFile?: string; mcpServers?: McpServer[] | undefined } = {},
	): Promise<PiSession> {
		const session = new PiSession({
			client: this.#client,
			cwd,
			piCommand: this.#options.piCommand,
			piArgs: this.#options.piArgs,
			env: this.#options.env,
			resumeSessionFile,
			mcpServers: toPiMcpServers(mcpServers, this.#options.log),
			log: this.#options.log,
		});

		try {
			await session.start();
		} catch (error) {
			await session.stop();
			throw internalError(`Failed to start pi: ${errorMessage(error)}`);
		}

		this.#sessions.set(session.sessionId, session);
		return session;
	}

	#session(sessionId: string): PiSession {
		const session = this.#sessions.get(sessionId);
		if (!session) throw resourceNotFound(`Unknown session: ${sessionId}`);
		return session;
	}

}

const LIST_PAGE_SIZE = 100;

/** Cursors are opaque to the client; this one is a base64url offset. */
function encodeCursor(offset: number): string {
	return Buffer.from(JSON.stringify({ offset })).toString("base64url");
}

function decodeCursor(cursor: string | null | undefined): number {
	if (!cursor) return 0;
	try {
		const { offset } = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as { offset?: unknown };
		if (typeof offset === "number" && Number.isInteger(offset) && offset >= 0) return offset;
	} catch {
		// Fall through to the error below.
	}
	throw invalidParams("Invalid session/list cursor");
}

function toRequestError(error: unknown): RequestError {
	if (error instanceof RequestError) return error;
	if (error instanceof PiRpcError) return invalidParams(error.message);
	return internalError(errorMessage(error));
}
