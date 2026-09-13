import type { BoundaryWorkspace } from "./boundary-config.ts";
import {
  BoundaryLabelManager,
  type BoundaryLabelDefinitions,
  type LabelClient,
  type ManagedWorkspace,
} from "./boundary-labels.ts";

const WORKSPACE_PAGE_LIMIT = 200;

export interface ManagementClient extends LabelClient {
  connect(): Promise<void>;
  close(): Promise<void>;
  fetchWorkspaces(options: {
    filter?: { projectId?: string };
    page: { limit: number; cursor?: string };
  }): Promise<{
    entries: ManagedWorkspace[];
    pageInfo: { nextCursor?: string | null };
  }>;
}

export interface CreatedWorkspace {
  id: string;
  projectId: string;
  cwd: string;
}

type ResolveBoundary = (workspace: BoundaryWorkspace) => string | null;

export class WorkspaceManagementService {
  private readonly client: ManagementClient;
  private readonly definitions: BoundaryLabelDefinitions;
  private readonly loadResolver: () => Promise<ResolveBoundary>;
  private resolveBoundary: ResolveBoundary = () => null;
  private manager: BoundaryLabelManager | null = null;
  private startup: Promise<void> | null = null;

  constructor(input: {
    client: ManagementClient;
    definitions: BoundaryLabelDefinitions;
    loadResolver: () => Promise<ResolveBoundary>;
  }) {
    this.client = input.client;
    this.definitions = input.definitions;
    this.loadResolver = input.loadResolver;
  }

  start(): Promise<void> {
    if (this.startup) return this.startup;
    this.startup = this.startOnce();
    return this.startup;
  }

  private async startOnce(): Promise<void> {
    await this.client.connect();
    this.resolveBoundary = await this.loadResolver();
    this.manager = new BoundaryLabelManager({
      client: this.client,
      definitions: this.definitions,
      resolveBoundary: (workspace) => this.resolveBoundary(workspace),
    });
    await this.manager.backfill(await this.listWorkspaces());
  }

  async workspaceCreated(event: CreatedWorkspace): Promise<void> {
    await this.start();
    this.resolveBoundary = await this.loadResolver();
    const candidates = await this.listWorkspaces({ projectId: event.projectId });
    const workspace =
      candidates.find((candidate) => candidate.id === event.id) ?? {
        ...event,
        labels: [],
      };
    await this.manager?.assign(workspace);
  }

  private async listWorkspaces(filter?: { projectId?: string }): Promise<ManagedWorkspace[]> {
    const workspaces: ManagedWorkspace[] = [];
    let cursor: string | undefined;
    do {
      const page = await this.client.fetchWorkspaces({
        ...(filter ? { filter } : {}),
        page: { limit: WORKSPACE_PAGE_LIMIT, ...(cursor ? { cursor } : {}) },
      });
      workspaces.push(...page.entries);
      cursor = page.pageInfo.nextCursor ?? undefined;
    } while (cursor);
    return workspaces;
  }

  async stop(): Promise<void> {
    await this.startup?.catch(() => undefined);
    await this.client.close();
  }
}
