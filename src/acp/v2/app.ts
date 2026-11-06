import type * as v1 from "@agentclientprotocol/sdk";
import * as v2 from "@agentclientprotocol/sdk/experimental/v2";
import { internalError, invalidParams, requestCancelled, resourceNotFound } from "../errors.js";
import { PACKAGE, PiAcpAgent, type PiAcpAgentOptions } from "../agent.js";
import { errorMessage } from "../session.js";
import { V2ClientPort } from "./client-port.js";
import { toV1McpServers, toV2ConfigOptions, unsupportedPromptContent } from "./translate.js";

/** What this agent supports, as v2 advertises it under `capabilities.session`. */
const SESSION_CAPABILITIES = {
	prompt: { image: {}, embeddedContext: {} },
	// Client-supplied servers are registered through a pi extension, which
	// speaks stdio and streamable HTTP.
	mcp: { stdio: {}, http: {} },
	delete: {},
} satisfies v2.SessionCapabilities;

/**
 * An ACP v2 (draft) agent app that serves pi over one connection.
 *
 * v2 runs on the same core as v1: a {@link V2ClientPort} turns the core's v1
 * messages into v2, and the handlers here turn v2 requests into the core's v1
 * calls. What v2 adds on top lives here and in the port: prompts answered as
 * soon as pi takes them, the session's foreground state, and resuming with a
 * replay instead of `session/load`.
 *
 * The draft is experimental and may change incompatibly; the version this
 * implements is the one in the pinned `@agentclientprotocol/sdk`.
 */
export function createPiAgentAppV2(options: PiAcpAgentOptions): { app: v2.AgentApp; shutdown: () => Promise<void> } {
	let frontEnd: V2FrontEnd | undefined;
	const connected = (): V2FrontEnd => {
		if (!frontEnd) throw internalError("ACP connection is not set up");
		return frontEnd;
	};

	const app = v2
		.agent({ name: PACKAGE.name })
		.onConnect((connection) => {
			if (frontEnd) throw new Error("createPiAgentAppV2 serves a single connection; build one app per connection");
			const current = new V2FrontEnd(connection.client, options);
			frontEnd = current;
			void connection.closed.then(() => current.shutdown());
		})
		.onRequest(v2.methods.agent.initialize, ({ params }) => connected().initialize(params))
		.onRequest(v2.methods.agent.session.new, ({ params }) => connected().newSession(params))
		.onRequest(v2.methods.agent.session.resume, ({ params }) => connected().resumeSession(params))
		.onRequest(v2.methods.agent.session.list, ({ params }) => connected().listSessions(params))
		.onRequest(v2.methods.agent.session.close, ({ params }) => connected().closeSession(params))
		.onRequest(v2.methods.agent.session.delete, ({ params }) => connected().deleteSession(params))
		.onRequest(v2.methods.agent.session.setConfigOption, ({ params }) => connected().setConfigOption(params))
		.onRequest(v2.methods.agent.session.prompt, ({ params }) => connected().prompt(params))
		.onNotification(v2.methods.agent.session.cancel, ({ params }) => connected().cancel(params));

	return { app, shutdown: async () => frontEnd?.shutdown() };
}

class V2FrontEnd {
	#port: V2ClientPort;
	#agent: PiAcpAgent;
	/** Per session, the running prompt turn: settles once its final state update is out. */
	#turns = new Map<string, Promise<void>>();

	constructor(client: v2.AgentContext, options: PiAcpAgentOptions) {
		this.#port = new V2ClientPort(client);
		this.#agent = new PiAcpAgent(this.#port, options);
	}

	async initialize(params: v2.InitializeRequest): Promise<v2.InitializeResponse> {
		this.#port.features = V2ClientPort.features(params.capabilities);
		// No auth methods: pi manages provider credentials itself (`pi auth
		// login`), so neither `auth/login` nor `auth/logout` is offered.
		return {
			protocolVersion: v2.PROTOCOL_VERSION,
			info: { name: PACKAGE.name, title: "pi", version: PACKAGE.version },
			capabilities: { session: SESSION_CAPABILITIES },
		};
	}

	async newSession(params: v2.NewSessionRequest): Promise<v2.NewSessionResponse> {
		v2.assertSupportedMcpServers(params.mcpServers, SESSION_CAPABILITIES.mcp);
		const response = await this.#agent.newSession({ cwd: params.cwd, mcpServers: toV1McpServers(params.mcpServers) });
		this.#port.open(response.sessionId);
		return { sessionId: response.sessionId, configOptions: toV2ConfigOptions(response.configOptions ?? []) };
	}

	/** v2's one way to reopen a session: with `replayFrom: start` it is v1's `session/load`. */
	async resumeSession(params: v2.ResumeSessionRequest): Promise<v2.ResumeSessionResponse> {
		const replayFrom = params.replayFrom;
		if (replayFrom != null && replayFrom.type !== "start") {
			throw invalidParams(`Unsupported replayFrom cursor "${String(replayFrom.type)}"`, { replayFrom });
		}
		v2.assertSupportedMcpServers(params.mcpServers, SESSION_CAPABILITIES.mcp);

		// A live session is restarted, which ends any turn it was running.
		await this.#endLiveSession(params.sessionId);
		this.#port.open(params.sessionId);
		const request = { sessionId: params.sessionId, cwd: params.cwd, mcpServers: toV1McpServers(params.mcpServers) };
		const response =
			replayFrom == null
				? await this.#agent.resumeSession(request)
				: await this.#port.replay(params.sessionId, () => this.#agent.loadSession(request));

		// v2 requires the current state before the response, replay or not.
		await this.#port.foreground(params.sessionId, { state: "idle" });
		return { configOptions: toV2ConfigOptions(response.configOptions ?? []) };
	}

	async listSessions(params: v2.ListSessionsRequest): Promise<v2.ListSessionsResponse> {
		return (await this.#agent.listSessions(params)) as v2.ListSessionsResponse;
	}

	/** Closing an unknown or already-closed session succeeds, as v2 asks. */
	async closeSession(params: v2.CloseSessionRequest): Promise<v2.CloseSessionResponse> {
		await this.#endLiveSession(params.sessionId);
		return {};
	}

	async deleteSession(params: v2.DeleteSessionRequest): Promise<v2.DeleteSessionResponse> {
		await this.#endLiveSession(params.sessionId);
		await this.#agent.deleteSession(params);
		return {};
	}

	async setConfigOption(params: v2.SetSessionConfigOptionRequest): Promise<v2.SetSessionConfigOptionResponse> {
		this.#requireSession(params.sessionId);
		if (params.type !== "id" || typeof params.value !== "string") {
			throw invalidParams(`Config option "${params.configId}" takes one of its listed values`);
		}
		const response = await this.#agent.setSessionConfigOption({
			sessionId: params.sessionId,
			configId: params.configId,
			value: params.value,
		});
		return { configOptions: toV2ConfigOptions(response.configOptions) };
	}

	/**
	 * Answers with the user message's id as soon as pi has taken the prompt;
	 * the turn then runs on, and its end is reported as an idle state update.
	 */
	async prompt(params: v2.PromptRequest): Promise<v2.PromptResponse> {
		const { sessionId } = params;
		this.#requireSession(sessionId);
		const unsupported = unsupportedPromptContent(params.prompt);
		if (unsupported !== undefined) {
			throw invalidParams(`Unsupported prompt content type "${unsupported}"`, { type: unsupported });
		}

		return new Promise<v2.PromptResponse>((resolve, reject) => {
			let inserted = false;
			const turn = this.#agent
				.prompt(
					{ sessionId, prompt: params.prompt as v1.ContentBlock[] },
					{
						onInserted: (messageId) => {
							inserted = true;
							// Both go out before anything the turn sends next.
							void this.#port.userMessage(sessionId, messageId, params.prompt);
							void this.#port.foreground(sessionId, { state: "running" });
							resolve({ messageId });
						},
					},
				)
				.then(
					async ({ stopReason }) => {
						if (!inserted) return reject(requestCancelled("The prompt was cancelled before pi took it"));
						await this.#port.foreground(sessionId, { state: "idle", stopReason });
					},
					async (error: unknown) => {
						// Once the prompt is in the conversation, a failure ends the turn
						// instead of failing the request.
						if (!inserted) return reject(error);
						const code = typeof (error as { code?: unknown }).code === "number" ? (error as { code: number }).code : -32603;
						await this.#port.foreground(sessionId, {
							state: "idle",
							stopReason: "error",
							error: { code, message: errorMessage(error) },
						});
					},
				);
			this.#turns.set(sessionId, turn);
			void turn.finally(() => {
				if (this.#turns.get(sessionId) === turn) this.#turns.delete(sessionId);
			});
		});
	}

	async cancel(params: v2.CancelSessionNotification): Promise<void> {
		// Open prompts count as not approved once the work they belong to is cancelled.
		this.#port.withdrawRequests(params.sessionId);
		await this.#agent.cancel(params);
	}

	async shutdown(): Promise<void> {
		await this.#agent.shutdown();
	}

	/**
	 * Cancel a live session's work and stop it, sending its last updates (a
	 * running turn ends with an idle `cancelled`) before the session goes quiet.
	 */
	async #endLiveSession(sessionId: string): Promise<void> {
		if (!this.#agent.hasSession(sessionId)) return;
		this.#port.withdrawRequests(sessionId);
		await this.#agent.closeSession({ sessionId });
		await this.#turns.get(sessionId)?.catch(() => undefined);
		this.#port.close(sessionId);
	}

	#requireSession(sessionId: string): void {
		if (!this.#agent.hasSession(sessionId)) throw resourceNotFound(`Unknown session: ${sessionId}`, { sessionId });
	}
}
