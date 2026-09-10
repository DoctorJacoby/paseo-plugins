import type { PluginClientContext } from "@getpaseo/plugin/client";
import * as contracts from "./shared/contracts.ts";
import { ClaudeTtySurface } from "./client/surface.tsx";

export const SURFACE_ID = "claude-tty";

export default function contribute(client: PluginClientContext) {
  client.addSurface(SURFACE_ID, ClaudeTtySurface);

  client.addSidebarItem({
    id: "claude-tty",
    title: "Claude TTY",
    icon: "SquareTerminal",
    surface: SURFACE_ID,
  });

  client.addCommandCenterItem({
    id: "claude-tty-doctor",
    title: "Claude TTY: run diagnostics",
    icon: "Stethoscope",
    keywords: ["claude", "adapter", "acp", "diagnose", "doctor", "provider"],
    context: "global",
    async onSelect({ rpc, openSurface }) {
      await rpc(contracts.runDoctor, {});
      openSurface(SURFACE_ID);
    },
  });

  client.addCommandCenterItem({
    id: "claude-tty-release-stale-locks",
    title: "Claude TTY: release stale session locks",
    icon: "LockOpen",
    keywords: ["claude", "adapter", "acp", "lock", "session", "stale"],
    context: "global",
    async onSelect({ rpc }) {
      await rpc(contracts.releaseStaleLocks, {});
    },
  });

  return () => {};
}
