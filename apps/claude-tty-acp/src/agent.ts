import {
  PROTOCOL_VERSION,
  type Agent,
  type AgentSideConnection,
  type AuthenticateRequest,
  type CancelNotification,
  type InitializeRequest,
  type InitializeResponse,
  type LoadSessionRequest,
  type LoadSessionResponse,
  type NewSessionRequest,
  type NewSessionResponse,
  type PromptRequest,
  type PromptResponse,
  type SetSessionConfigOptionRequest,
  type SetSessionConfigOptionResponse,
  type SetSessionModeRequest,
  type SetSessionModelRequest,
  RequestError,
} from "@agentclientprotocol/sdk";
import { APP_NAME, APP_TITLE, APP_VERSION } from "./constants.ts";
import { HookServer } from "./hook-server.ts";
import { writeLog } from "./log.ts";
import { SessionRefused } from "./session-placement.ts";
import { type ClaudeSession, SessionRegistry, type SessionRegistryDependencies } from "./session-registry.ts";
import { WorkspaceWatchdog } from "./workspace-watchdog.ts";

export type ClaudeTtyAgentDependencies = SessionRegistryDependencies & {
  /** Left out by anything that is not the adapter's own process, which is the only one with a process to stop. */
  onWorkspacesRemoved?: () => void;
  workspaceCheckIntervalMs?: number;
};

export class ClaudeTtyAgent implements Agent {
  readonly hooks = new HookServer();
  readonly sessions: SessionRegistry;
  readonly connection: AgentSideConnection;
  private readonly workspaces: WorkspaceWatchdog | null;

  constructor(connection: AgentSideConnection, dependencies: ClaudeTtyAgentDependencies = {}) {
    const { onWorkspacesRemoved, workspaceCheckIntervalMs, ...sessionDependencies } = dependencies;
    this.connection = connection;
    this.sessions = new SessionRegistry(connection, this.hooks, sessionDependencies);
    this.workspaces = onWorkspacesRemoved ? new WorkspaceWatchdog(onWorkspacesRemoved, workspaceCheckIntervalMs) : null;
  }

  async initialize(_params: InitializeRequest): Promise<InitializeResponse> {
    return {
      protocolVersion: PROTOCOL_VERSION,
      agentCapabilities: {
        loadSession: true,
        promptCapabilities: {
          embeddedContext: true,
          image: true,
          audio: false,
        },
      },
      agentInfo: {
        name: APP_NAME,
        title: APP_TITLE,
        version: APP_VERSION,
      },
      authMethods: [],
    };
  }

  /**
   * What a refused turn answers with: JSON-RPC's invalid-params, since the working directory is the
   * parameter this host will not run a session in, carrying the host's own reason rather than the
   * SDK's wording for it. A plain throw would reach the client as "Internal error" with the reason
   * buried in data that nothing shows, which is a refusal nobody can act on.
   */
  static readonly REFUSED_CODE = -32602;

  async newSession(params: NewSessionRequest): Promise<NewSessionResponse> {
    if (params.mcpServers.length > 0) {
      throw new Error(`${APP_TITLE} does not accept ACP-injected MCP servers`);
    }
    const session = this.sessions.create(params.cwd);
    await session.refreshAutoAccept({ publish: false });
    // Where the session runs is settled here rather than at the first prompt, so that the answer is
    // in the log from the start and a box is built before anything waits on it.
    let refused: SessionRefused | null = null;
    try {
      const placement = await session.placement();
      if (!placement.boxed) {
        writeLog({ level: "info", message: "Opening a session on this host rather than in a box", sessionId: session.id, cwd: session.cwd, reason: placement.reason });
      }
    } catch (error) {
      if (!(error instanceof SessionRefused)) throw error;
      // A refusal ends the session's first turn, and does not fail `session/new` itself. The daemon
      // builds this provider's catalogue from the first session opened on a connection, and a
      // rejected open there is remembered against the provider: every later spawn, in any
      // workspace, then gets this refusal instead of a session, until the adapter is built again
      // (seen 2026-09-12, Paseo 0.8.0). Refusing the turn instead costs nothing -- the placement is
      // resolved again before Claude is started, and refuses again -- and no session that was
      // refused ever starts anything on this host.
      refused = error;
      writeLog({ level: "warn", message: "Refused a session's placement; its first prompt will say so", sessionId: session.id, cwd: session.cwd, reason: error.message });
    }
    this.workspaces?.watch(session.id, session.cwd);
    // The client first learns this session id from the response below, so an update sent any earlier
    // has nowhere to land. A refused session has no commands to discover -- discovery reads the box
    // it will not get -- and the daemon waits on that update before it calls the session open.
    setImmediate(() => void (refused ? this.publishNoCommands(session) : this.publishCommands(session)));
    writeLog({ level: "info", message: "Created lazy ACP session", sessionId: session.id, cwd: session.cwd });
    return { sessionId: session.id, models: session.models, modes: session.modes, configOptions: session.configOptions };
  }

  async authenticate(_params: AuthenticateRequest): Promise<Record<string, never>> {
    return {};
  }

  async loadSession(params: LoadSessionRequest): Promise<LoadSessionResponse> {
    if (params.mcpServers.length > 0) throw new Error(`${APP_TITLE} does not accept ACP-injected MCP servers`);
    const session = await this.sessions.load(params.sessionId, params.cwd);
    await session.refreshAutoAccept({ publish: false });
    this.workspaces?.watch(session.id, session.cwd);
    // The client first learns this session id from the response below, so the conversation and the
    // command list go after it, for the same reason `newSession` publishes its commands after its
    // own: an update sent earlier has nowhere to land. Replayed ahead of the response, the whole
    // history of a resumed session is what that costs -- the conversation survives on disk and in
    // Claude, and the client shows an empty timeline.
    setImmediate(() => void this.restoreSession(session));
    writeLog({ level: "info", message: "Loaded persisted ACP session", sessionId: params.sessionId, cwd: params.cwd });
    return { models: session.models, modes: session.modes, configOptions: session.configOptions };
  }

  async setSessionMode(params: SetSessionModeRequest): Promise<Record<string, never>> {
    const session = this.sessions.get(params.sessionId);
    if (!session) throw new Error(`Session ${params.sessionId} not found`);
    await session.setMode(params.modeId);
    return {};
  }

  /** Kept beside `setSessionConfigOption` because the daemon's own ACP bridge asks for a model this way first and only falls back to the config option. */
  async unstable_setSessionModel(params: SetSessionModelRequest): Promise<Record<string, never>> {
    const session = this.sessions.get(params.sessionId);
    if (!session) throw new Error(`Session ${params.sessionId} not found`);
    await session.setModel(params.modelId);
    return {};
  }

  async setSessionConfigOption(params: SetSessionConfigOptionRequest): Promise<SetSessionConfigOptionResponse> {
    const session = this.sessions.get(params.sessionId);
    if (!session) throw new Error(`Session ${params.sessionId} not found`);
    return { configOptions: await session.setConfigOption(params.configId, params.value) };
  }

  async prompt(params: PromptRequest): Promise<PromptResponse> {
    const session = this.sessions.get(params.sessionId);
    if (!session) throw new Error(`Session ${params.sessionId} not found`);
    try {
      return await session.prompt(params.prompt);
    } catch (error) {
      if (!(error instanceof SessionRefused)) throw error;
      throw new RequestError(ClaudeTtyAgent.REFUSED_CODE, error.message, { cwd: session.cwd });
    }
  }

  async cancel(params: CancelNotification): Promise<void> {
    this.sessions.get(params.sessionId)?.cancel();
  }

  async close(): Promise<void> {
    this.workspaces?.stop();
    await this.sessions.clear();
    await this.hooks.close();
  }

  /**
   * Puts a resumed session's conversation back in front of the client, then its commands.
   * History first, because the command list is what the client reads as the session being ready to
   * use. A replay that fails costs the timeline, not the session: Claude still holds the
   * conversation, so the session is left open to carry on rather than failed for its history.
   */
  private async restoreSession(session: ClaudeSession): Promise<void> {
    try {
      await session.replayHistory();
    } catch (error) {
      writeLog({ level: "warn", message: "Failed to replay a loaded session's history", sessionId: session.id, error: errorMessage(error) });
    }
    await this.publishCommands(session);
  }

  /** What a refused session offers: nothing, said out loud, so that nobody waits for a list that is never coming. */
  private async publishNoCommands(session: ClaudeSession): Promise<void> {
    try {
      await this.connection.sessionUpdate({ sessionId: session.id, update: { sessionUpdate: "available_commands_update", availableCommands: [] } });
    } catch (error) {
      writeLog({ level: "warn", message: "Failed to publish an empty command list", sessionId: session.id, error: errorMessage(error) });
    }
  }

  private async publishCommands(session: ClaudeSession): Promise<void> {
    try {
      await session.emitCommands();
    } catch (error) {
      writeLog({ level: "warn", message: "Failed to publish available commands", sessionId: session.id, error: errorMessage(error) });
    }
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
