import type { PluginServerContext } from "@getpaseo/plugin/server";
import { loadBoundaryResolver } from "./server/boundary-config.ts";
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
  const service = new WorkspaceManagementService({
    definitions: BOUNDARY_LABELS,
    loadResolver: () => loadBoundaryResolver(),
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
