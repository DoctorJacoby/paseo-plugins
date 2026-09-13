import type { PluginServerContext } from "@getpaseo/plugin/server";
import { loadBoundaryResolver } from "./server/boundary-config.ts";
import { WorkspaceManagementDaemonClient } from "./server/daemon.ts";
import { BOUNDARY_LABELS } from "./server/labels.ts";
import { WorkspaceManagementService } from "./server/service.ts";

function report(operation: string, error: unknown): void {
  console.error(
    `workspace-management ${operation} failed`,
    error instanceof Error ? error : new Error(String(error)),
  );
}

export default function contribute(server: PluginServerContext) {
  const service = new WorkspaceManagementService({
    client: new WorkspaceManagementDaemonClient(),
    definitions: BOUNDARY_LABELS,
    loadResolver: () => loadBoundaryResolver(),
  });

  void service.start().catch((error) => report("startup backfill", error));
  server.on("workspace.created", ({ workspace }) =>
    service.workspaceCreated(workspace).catch((error) => report("workspace creation hook", error)),
  );

  return () => service.stop();
}
