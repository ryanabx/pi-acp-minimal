import type {
	Agent,
	AgentSideConnection,
	AuthenticateRequest,
	CancelNotification,
	ClientCapabilities,
	InitializeRequest,
	InitializeResponse,
	LoadSessionRequest,
	LoadSessionResponse,
	NewSessionRequest,
	NewSessionResponse,
	PromptRequest,
	PromptResponse,
	SetSessionConfigOptionRequest,
	SetSessionConfigOptionResponse,
} from "@agentclientprotocol/sdk";
import { PROTOCOL_VERSION, RequestError } from "@agentclientprotocol/sdk";
import { isThinkingLevel, MODEL_CONFIG_ID, THINKING_CONFIG_ID } from "../map/config.js";
import { toPiPrompt } from "../map/content.js";
import { PiRpcError } from "../pi/rpc-client.js";
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

/**
 * ACP agent backed by `pi --mode rpc`.
 *
 * Each ACP session owns one pi child process rooted at the session's cwd, which
 * is also how per-session working directories, settings and extensions are honoured.
 */
export class PiAcpAgent implements Agent {
	#connection: AgentSideConnection;
	#options: PiAcpAgentOptions;
	#clientCapabilities: ClientCapabilities | undefined;
	#sessions = new Map<string, PiSession>();

	constructor(connection: AgentSideConnection, options: PiAcpAgentOptions) {
		this.#connection = connection;
		this.#options = options;
	}

	async initialize(params: InitializeRequest): Promise<InitializeResponse> {
		this.#clientCapabilities = params.clientCapabilities;
		return {
			protocolVersion: Math.min(params.protocolVersion, PROTOCOL_VERSION),
			agentCapabilities: {
				loadSession: true,
				promptCapabilities: { image: true, embeddedContext: true, audio: false },
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
		this.#warnAboutMcpServers(params.mcpServers?.length ?? 0);
		const session = await this.#startSession(params.cwd);
		// Commands are published only after this response is on the wire: a client
		// cannot route a session/update for a session it has not been told about yet.
		session.publishSessionStateSoon();
		return { sessionId: session.sessionId, configOptions: session.configOptions() };
	}

	async loadSession(params: LoadSessionRequest): Promise<LoadSessionResponse> {
		this.#warnAboutMcpServers(params.mcpServers?.length ?? 0);
		if (params.sessionId.startsWith(UNPERSISTED_SESSION_PREFIX)) {
			throw invalidParams("This session was created without persistence and cannot be reloaded");
		}

		await this.#sessions.get(params.sessionId)?.stop();
		this.#sessions.delete(params.sessionId);

		const session = await this.#startSession(params.cwd, params.sessionId);
		if (session.sessionId !== params.sessionId) {
			// pi resolved `--session` to a different file; the client only knows the
			// id it asked for, so keep that one authoritative everywhere.
			this.#sessions.delete(session.sessionId);
			session.adoptSessionId(params.sessionId);
			this.#sessions.set(params.sessionId, session);
		}
		// session/load streams history while the request is in flight: the client
		// already knows this session id because it supplied it.
		await session.replayHistory();
		await session.publishCommands();
		return { configOptions: session.configOptions() };
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

	async prompt(params: PromptRequest): Promise<PromptResponse> {
		const session = this.#session(params.sessionId);
		const { message, images } = toPiPrompt(params.prompt);
		if (!message && images.length === 0) throw invalidParams("Prompt is empty");

		const stopReason = await session.prompt(message, images);
		return { stopReason };
	}

	async cancel(params: CancelNotification): Promise<void> {
		await this.#sessions.get(params.sessionId)?.cancel();
	}

	/** Shut every pi child process down; used when the ACP connection closes. */
	async shutdown(): Promise<void> {
		const sessions = [...this.#sessions.values()];
		this.#sessions.clear();
		await Promise.all(sessions.map((session) => session.stop()));
	}

	async #startSession(cwd: string, resumeSessionFile?: string): Promise<PiSession> {
		const session = new PiSession({
			connection: this.#connection,
			clientCapabilities: this.#clientCapabilities,
			cwd,
			piCommand: this.#options.piCommand,
			piArgs: this.#options.piArgs,
			env: this.#options.env,
			resumeSessionFile,
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

	#warnAboutMcpServers(count: number): void {
		if (count > 0) {
			this.#options.log(
				`ignoring ${count} client-supplied MCP server(s): pi loads MCP servers from its own settings, not from ACP`,
			);
		}
	}
}


function toRequestError(error: unknown): RequestError {
	if (error instanceof RequestError) return error;
	if (error instanceof PiRpcError) return invalidParams(error.message);
	return internalError(errorMessage(error));
}
