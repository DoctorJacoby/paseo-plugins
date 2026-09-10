import type { PluginClientContext } from "@getpaseo/plugin/client";
import * as contracts from "./shared/contracts.ts";
import { ClaudeTtySettings } from "./client/settings.tsx";
import { ClaudeTtySurface } from "./client/surface.tsx";

export const SURFACE_ID = "claude-tty";
export const SETTINGS_SCREEN_ID = "claude-tty";

export default function contribute(client: PluginClientContext) {
  client.addSurface(SURFACE_ID, ClaudeTtySurface);

  client.addSidebarItem({
    id: "claude-tty",
    title: "Claude TTY",
    icon: "SquareTerminal",
    surface: SURFACE_ID,
  });

  client.addSettingsScreen({
    id: SETTINGS_SCREEN_ID,
    title: "Claude TTY",
    icon: "SquareTerminal",
    Component: ClaudeTtySettings,
  });

  // The panel cannot reach the settings screen: `openSettings` is on command contexts, never on a
  // surface's props. This is the affordance that does, alongside Settings → Plugins itself.
  client.addCommandCenterItem({
    id: "claude-tty-settings",
    title: "Claude TTY: settings",
    icon: "Settings",
    keywords: ["claude", "adapter", "acp", "idle", "suspend", "timeout"],
    context: "global",
    onSelect({ openSettings }) {
      openSettings(SETTINGS_SCREEN_ID);
    },
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
