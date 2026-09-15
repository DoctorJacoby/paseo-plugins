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
} from "@agentclientprotocol/sdk";
import { APP_NAME, APP_TITLE, APP_VERSION } from "./constants.ts";
import { HookServer } from "./hook-server.ts";
import { writeLog } from "./log.ts";
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

  async newSession(params: NewSessionRequest): Promise<NewSessionResponse> {
    if (params.mcpServers.length > 0) {
      throw new Error(`${APP_TITLE} does not accept ACP-injected MCP servers`);
    }
    const session = this.sessions.create(params.cwd);
    await session.refreshAutoAccept({ publish: false });
    this.workspaces?.watch(session.id, session.cwd);
    // The client first learns this session id from the response below, so an update sent any earlier has nowhere to land.
    setImmediate(() => void this.publishCommands(session));
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
    await session.emitCommands();
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
    return session.prompt(params.prompt);
  }

  async cancel(params: CancelNotification): Promise<void> {
    this.sessions.get(params.sessionId)?.cancel();
  }

  async close(): Promise<void> {
    this.workspaces?.stop();
    await this.sessions.clear();
    await this.hooks.close();
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
