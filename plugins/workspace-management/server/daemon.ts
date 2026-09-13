import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import type { Env } from "./boundary-config.ts";
import type { ManagedWorkspace, WorkspaceLabelDefinition } from "./boundary-labels.ts";
import type { ManagementClient } from "./service.ts";

const CLIENT_ID = "workspace-management";
const LABEL_SUBSCRIPTION_ID = "workspace-management-label-catalog";
const DEFAULT_DAEMON_HOST = "127.0.0.1:6767";

async function readJson(target: string): Promise<Record<string, unknown> | null> {
  try {
    const parsed: unknown = JSON.parse(await fs.readFile(target, "utf8"));
    return typeof parsed === "object" && parsed !== null
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function stringField(record: Record<string, unknown> | null, field: string): string | null {
  const value = record?.[field];
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

function paseoHome(env: Env): string {
  return env.PASEO_HOME?.trim() || path.join(env.HOME?.trim() || os.homedir(), ".paseo");
}

function daemonUrl(host: string): string {
  if (host.startsWith("unix://") || host.startsWith("pipe://") || host.startsWith("\\\\.\\pipe\\")) {
    throw new Error(`Workspace management cannot dial the Paseo daemon at ${host}`);
  }
  const withoutScheme = host.startsWith("tcp://") ? host.slice("tcp://".length) : host;
  if (withoutScheme.startsWith("ws://") || withoutScheme.startsWith("wss://")) {
    return withoutScheme.endsWith("/ws")
      ? withoutScheme
      : `${withoutScheme.replace(/\/$/, "")}/ws`;
  }
  return `ws://${withoutScheme.replace(/\/$/, "")}/ws`;
}

function managedWorkspace(workspace: {
  id: string;
  projectId: string;
  workspaceDirectory?: string;
  projectRootPath: string;
  labels?: string[];
}): ManagedWorkspace {
  return {
    id: workspace.id,
    projectId: workspace.projectId,
    cwd: workspace.workspaceDirectory ?? workspace.projectRootPath,
    projectRootPath: workspace.projectRootPath,
    labels: [...(workspace.labels ?? [])],
  };
}

export class WorkspaceManagementDaemonClient implements ManagementClient {
  private readonly env: Env;
  private client: DaemonClient | null = null;

  constructor(env: Env = process.env) {
    this.env = env;
  }

  async connect(): Promise<void> {
    if (this.client) return;
    const home = paseoHome(this.env);
    const [pid, config] = await Promise.all([
      readJson(path.join(home, "paseo.pid")),
      readJson(path.join(home, "config.json")),
    ]);
    const daemon = (config?.daemon ?? null) as Record<string, unknown> | null;
    const host =
      this.env.PASEO_HOST?.trim() ||
      this.env.PASEO_LISTEN?.trim() ||
      stringField(pid, "listen") ||
      stringField(pid, "sockPath") ||
      stringField(daemon, "listen") ||
      DEFAULT_DAEMON_HOST;
    const client = new DaemonClient({
      url: daemonUrl(host),
      clientId: CLIENT_ID,
      clientType: "cli",
      password: this.env.PASEO_PASSWORD || undefined,
      reconnect: { enabled: true, baseDelayMs: 1_000, maxDelayMs: 30_000 },
    });
    try {
      await client.connect();
      this.client = client;
    } catch (error) {
      await client.close().catch(() => undefined);
      throw error;
    }
  }

  private connected(): DaemonClient {
    if (!this.client) throw new Error("Workspace management is not connected to Paseo");
    return this.client;
  }

  async fetchWorkspaces(options: {
    filter?: { projectId?: string };
    page: { limit: number; cursor?: string };
  }) {
    const payload = await this.connected().fetchWorkspaces(options);
    return {
      entries: payload.entries.map(managedWorkspace),
      pageInfo: payload.pageInfo,
    };
  }

  async listWorkspaceLabels(): Promise<{ labels: WorkspaceLabelDefinition[] }> {
    const payload = await this.connected().listWorkspaceLabels({
      subscriptionId: LABEL_SUBSCRIPTION_ID,
    });
    return { labels: payload.labels };
  }

  setWorkspaceLabel(input: {
    workspaceId: string;
    label: WorkspaceLabelDefinition;
    assigned: boolean;
  }): Promise<unknown> {
    return this.connected().setWorkspaceLabel(input);
  }

  updateWorkspaceLabel(input: {
    name: string;
    color: WorkspaceLabelDefinition["color"];
  }): Promise<unknown> {
    return this.connected().updateWorkspaceLabel(input);
  }

  async close(): Promise<void> {
    const client = this.client;
    this.client = null;
    await client?.close();
  }
}
