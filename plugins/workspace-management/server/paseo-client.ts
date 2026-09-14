import type { PaseoApi } from "@getpaseo/client";
import type { ManagedWorkspace, WorkspaceLabelDefinition } from "./boundary-labels.ts";
import type { ManagementClient } from "./service.ts";

const WORKSPACE_PAGE_LIMIT = 200;

/**
 * The label calls on the injected `PaseoApi`.
 *
 * They are described here rather than imported because the published `@getpaseo/client@0.8.0`
 * types predate them: labels are a daemon feature with no SDK surface until
 * `feat/plugin-api-workspace-labels` lands upstream, and this host serves that patch itself. A
 * structural description keeps this plugin compiling against the released types while calling
 * what the patched daemon injects, and `requireLabelApi` turns an unpatched host into one clear
 * sentence instead of a `TypeError` inside a hook.
 */
interface WorkspaceLabelApi {
  list(): Promise<{ labels: WorkspaceLabelDefinition[] }>;
  update(options: { name: string; color: WorkspaceLabelDefinition["color"] }): Promise<unknown>;
  set(
    workspaceId: string,
    label: WorkspaceLabelDefinition,
    assigned: boolean,
  ): Promise<unknown>;
}

type Workspaces = PaseoApi["workspaces"] & { labels?: WorkspaceLabelApi };

export function requireLabelApi(paseo: PaseoApi): WorkspaceLabelApi {
  const labels = (paseo.workspaces as Workspaces).labels;
  if (!labels) {
    throw new Error(
      "This Paseo daemon's plugin API has no workspace labels. workspace-management needs a daemon carrying the workspace-label SDK surface.",
    );
  }
  return labels;
}

/** Everything this plugin asks of Paseo, over the API the server runtime injects and nothing else. */
export class PaseoManagementClient implements ManagementClient {
  private readonly paseo: PaseoApi;
  private readonly labels: WorkspaceLabelApi;

  constructor(paseo: PaseoApi) {
    this.paseo = paseo;
    this.labels = requireLabelApi(paseo);
  }

  async listWorkspaceLabels(): Promise<{ labels: WorkspaceLabelDefinition[] }> {
    return { labels: (await this.labels.list()).labels };
  }

  setWorkspaceLabel(input: {
    workspaceId: string;
    label: WorkspaceLabelDefinition;
    assigned: boolean;
  }): Promise<unknown> {
    return this.labels.set(input.workspaceId, input.label, input.assigned);
  }

  updateWorkspaceLabel(input: {
    name: string;
    color: WorkspaceLabelDefinition["color"];
  }): Promise<unknown> {
    return this.labels.update(input);
  }

  async listWorkspaces(): Promise<ManagedWorkspace[]> {
    const workspaces: ManagedWorkspace[] = [];
    let cursor: string | undefined;
    do {
      const page = await this.paseo.workspaces.list({
        page: { limit: WORKSPACE_PAGE_LIMIT, ...(cursor ? { cursor } : {}) },
      });
      for (const entry of page.entries) {
        workspaces.push({
          id: entry.id,
          projectId: entry.projectId,
          cwd: entry.workspaceDirectory ?? entry.projectRootPath,
          projectRootPath: entry.projectRootPath,
          labels: [...(entry.labels ?? [])],
        });
      }
      cursor = page.pageInfo.nextCursor ?? undefined;
    } while (cursor);
    return workspaces;
  }
}
