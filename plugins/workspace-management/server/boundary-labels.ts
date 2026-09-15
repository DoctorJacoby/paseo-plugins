export const WORKSPACE_LABEL_COLORS = [
  "violet",
  "sky",
  "emerald",
  "orange",
  "pink",
  "indigo",
  "teal",
  "red",
  "amber",
  "blue",
] as const;

export type WorkspaceLabelColor = (typeof WORKSPACE_LABEL_COLORS)[number];

export interface WorkspaceLabelDefinition {
  name: string;
  color: WorkspaceLabelColor;
}

export interface ManagedWorkspace {
  id: string;
  projectId: string;
  cwd: string;
  projectRootPath?: string;
  labels?: string[];
}

export interface LabelClient {
  listWorkspaceLabels(): Promise<{ labels: WorkspaceLabelDefinition[] }>;
  setWorkspaceLabel(input: {
    workspaceId: string;
    label: WorkspaceLabelDefinition;
    assigned: boolean;
  }): Promise<unknown>;
  updateWorkspaceLabel(input: {
    name: string;
    color: WorkspaceLabelColor;
  }): Promise<unknown>;
}

export type BoundaryLabelDefinitions = Readonly<Record<string, WorkspaceLabelDefinition>>;

function labelKey(name: string): string {
  return name.replace(/\s+/g, " ").trim().toLowerCase();
}

/**
 * Reconciliation only ever adds assignments. A label on a workspace may have been put there by a
 * human, including one that resembles an old boundary, so absence from today's host config is not
 * authority to remove it.
 *
 * `repair` is the one exception, and it is opt-in per run rather than a new default. It removes a
 * managed boundary label only from a workspace whose boundary resolved to a *different* managed
 * one -- so the host has positively said this workspace is in `cebud-work`, and the `host` chip
 * next to it contradicts that. Nothing is removed on an unknown boundary, on a boundary with no
 * entry in `definitions`, or for a name this plugin does not manage: a human's own labels are
 * never in `definitions` and so are never touched. That keeps "absence is not authority" intact
 * while leaving a way to undo an assignment a bug made.
 */
export class BoundaryLabelManager {
  private operations: Promise<void> = Promise.resolve();
  private catalog: Map<string, WorkspaceLabelDefinition> | null = null;
  private readonly client: LabelClient;
  private readonly definitions: BoundaryLabelDefinitions;
  private readonly resolveBoundary: (workspace: ManagedWorkspace) => string | null;
  private readonly repair: boolean;
  private readonly reportRepair: (message: string) => void;

  constructor(input: {
    client: LabelClient;
    definitions: BoundaryLabelDefinitions;
    resolveBoundary: (workspace: ManagedWorkspace) => string | null;
    /** Defaults to false: an upgrade must not start taking labels off by itself. */
    repair?: boolean;
    onRepair?: (message: string) => void;
  }) {
    this.client = input.client;
    this.definitions = input.definitions;
    this.resolveBoundary = input.resolveBoundary;
    this.repair = input.repair ?? false;
    this.reportRepair = input.onRepair ?? ((message) => console.warn(message));
  }

  backfill(workspaces: readonly ManagedWorkspace[]): Promise<void> {
    return this.exclusive(() => this.reconcile(workspaces));
  }

  assign(workspace: ManagedWorkspace): Promise<void> {
    return this.exclusive(() => this.reconcile([workspace]));
  }

  private async reconcile(workspaces: readonly ManagedWorkspace[]): Promise<void> {
    const catalog = await this.getCatalog();

    for (const definition of Object.values(this.definitions)) {
      const current = catalog.get(labelKey(definition.name));
      if (current && current.color !== definition.color) {
        const result = await this.client.updateWorkspaceLabel({
          name: current.name,
          color: definition.color,
        });
        void result;
        catalog.set(labelKey(definition.name), { ...current, color: definition.color });
      }
    }

    for (const workspace of workspaces) {
      const boundary = this.resolveBoundary(workspace);
      const definition = boundary ? this.definitions[boundary] : undefined;
      if (!definition) continue;
      const definitionKey = labelKey(definition.name);
      const assigned = workspace.labels?.some((name) => labelKey(name) === definitionKey) ?? false;
      if (!assigned || !catalog.has(definitionKey)) {
        await this.client.setWorkspaceLabel({
          workspaceId: workspace.id,
          label: definition,
          assigned: true,
        });
        catalog.set(definitionKey, definition);
        workspace.labels ??= [];
        if (!workspace.labels.some((name) => labelKey(name) === definitionKey)) {
          workspace.labels.push(definition.name);
        }
      }
      if (this.repair) await this.removeContradicted(workspace, definitionKey);
    }
  }

  /** Every other managed boundary label on a workspace whose boundary is known to be `keep`. */
  private async removeContradicted(workspace: ManagedWorkspace, keep: string): Promise<void> {
    for (const definition of Object.values(this.definitions)) {
      const key = labelKey(definition.name);
      if (key === keep) continue;
      if (!workspace.labels?.some((name) => labelKey(name) === key)) continue;
      await this.client.setWorkspaceLabel({
        workspaceId: workspace.id,
        label: definition,
        assigned: false,
      });
      workspace.labels = workspace.labels.filter((name) => labelKey(name) !== key);
      this.reportRepair(
        `workspace-management: removed the "${definition.name}" label from workspace ${workspace.id}, which the host places in "${keep}".`,
      );
    }
  }

  private async getCatalog(): Promise<Map<string, WorkspaceLabelDefinition>> {
    if (this.catalog) return this.catalog;
    const listed = await this.client.listWorkspaceLabels();
    this.catalog = new Map(listed.labels.map((label) => [labelKey(label.name), label]));
    return this.catalog;
  }

  private async exclusive(operation: () => Promise<void>): Promise<void> {
    const previous = this.operations;
    let release!: () => void;
    this.operations = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      await operation();
    } finally {
      release();
    }
  }
}
