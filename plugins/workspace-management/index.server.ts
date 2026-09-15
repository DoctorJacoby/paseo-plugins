import type { PluginServerContext } from "@getpaseo/plugin/server";
import { loadBoundaryResolver, repairsRequested } from "./server/boundary-config.ts";
import { BOUNDARY_LABELS } from "./server/labels.ts";
import { PaseoManagementClient } from "./server/paseo-client.ts";
import { WorkspaceManagementService } from "./server/service.ts";

function report(operation: string, error: unknown): void {
  console.error(
    `workspace-management ${operation} failed`,
    error instanceof Error ? error : new Error(String(error)),
  );
}

export default function contribute(server: PluginServerContext) {
  const repair = repairsRequested();
  if (repair) {
    console.warn(
      "workspace-management: WORKSPACE_MANAGEMENT_REPAIR_LABELS is set, so this run will take a managed boundary label off any workspace the host places in a different boundary. Unset it once the sweep has run.",
    );
  }
  const service = new WorkspaceManagementService({
    definitions: BOUNDARY_LABELS,
    loadResolver: () => loadBoundaryResolver(),
    repair,
  });

  // The hook's context is where a server-side plugin is given its `PaseoApi`; there is no other
  // handle on the daemon, which is why the backfill rides the first event rather than startup.
  const unsubscribe = server.on("workspace.created", ({ workspace }, { paseo }) =>
    service
      .workspaceCreated(new PaseoManagementClient(paseo), workspace)
      .catch((error) => report("workspace creation hook", error)),
  );

  return () => unsubscribe();
}
