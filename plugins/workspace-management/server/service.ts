import type { BoundaryResolver } from "./boundary-config.ts";
import {
  BoundaryLabelManager,
  type BoundaryLabelDefinitions,
  type LabelClient,
  type ManagedWorkspace,
} from "./boundary-labels.ts";

export interface ManagementClient extends LabelClient {
  listWorkspaces(): Promise<ManagedWorkspace[]>;
}

export interface CreatedWorkspace {
  id: string;
  projectId: string;
  cwd: string;
}

/**
 * The plugin's own state, kept out of `index.server.ts` so it can be driven by a fake client.
 *
 * The backfill is lazy rather than run at startup, and that is forced rather than chosen: the
 * server runtime hands a plugin its `PaseoApi` on a hook or an RPC context and nowhere else, so
 * the contribution function has no daemon to talk to. The first workspace event is therefore what
 * pays for the sweep over everything already open, and every event after it costs one workspace.
 */
export class WorkspaceManagementService {
  private readonly definitions: BoundaryLabelDefinitions;
  private readonly loadResolver: () => Promise<BoundaryResolver>;
  private readonly repair: boolean;
  private resolveBoundary: BoundaryResolver = () => null;
  private manager: BoundaryLabelManager | null = null;
  private backfilled = false;

  constructor(input: {
    definitions: BoundaryLabelDefinitions;
    loadResolver: () => Promise<BoundaryResolver>;
    repair?: boolean;
  }) {
    this.definitions = input.definitions;
    this.loadResolver = input.loadResolver;
    this.repair = input.repair ?? false;
  }

  async workspaceCreated(client: ManagementClient, event: CreatedWorkspace): Promise<void> {
    // The host's maps are re-read per event: a project boxed an hour ago should not need a
    // daemon restart to start colouring its workspaces.
    this.resolveBoundary = await this.loadResolver();
    const manager = this.ensureManager(client);
    const created: ManagedWorkspace = { ...event, labels: [] };
    if (this.backfilled) {
      await manager.assign(created);
      return;
    }
    // The directory already holds the new workspace in the ordinary case; carrying it separately
    // only covers the daemon answering from a snapshot taken before this event.
    const open = await client.listWorkspaces();
    const workspaces = open.some((workspace) => workspace.id === created.id)
      ? open
      : [...open, created];
    this.backfilled = true;
    await manager.backfill(workspaces);
  }

  private ensureManager(client: ManagementClient): BoundaryLabelManager {
    this.manager ??= new BoundaryLabelManager({
      client,
      definitions: this.definitions,
      resolveBoundary: (workspace) => this.resolveBoundary(workspace),
      repair: this.repair,
    });
    return this.manager;
  }
}
