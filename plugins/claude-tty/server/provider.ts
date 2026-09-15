import { stat } from "node:fs/promises";
import { runAcpProvider } from "@getpaseo/plugin/server/acp";
import type { ProviderRegistration } from "@getpaseo/plugin/server/provider";
import { PROVIDER_ID, PROVIDER_LABEL } from "../shared/provider.ts";
import { resolveRepoRoot } from "./checkout.ts";
import { adapterBinaryPath, adapterEntryPath } from "./paths.ts";
import { withSteerFallback } from "./steering.ts";
import { toolCallDetails } from "./tool-details.ts";

/**
 * Claude publishes its slash commands and skills after `initialize`, over `available_commands_update`,
 * so a session that does not wait for that first update opens with none. The daemon's own ACP path
 * hardcodes the wait for the `traecli` provider ID; a plugin provider asks for it here instead,
 * which is what lets this one carry an ID of its own.
 */
const INITIAL_COMMANDS_TIMEOUT_MS = 10_000;

/** Read from the plugin directory and sanitised by the daemon when the plugin starts. */
const PROVIDER_ICON = "icon.svg";

/**
 * Resolved once. The checkout is read out of `plugins.claude-tty.path` in the daemon configuration,
 * which is the path the daemon loaded *this* plugin process from and cannot change under it: moving
 * a plugin is a configuration change, and the daemon starts a new process for the plugin it reloads.
 */
let checkoutRoot: string | null = null;

async function resolveCheckoutRoot(): Promise<string | null> {
  if (checkoutRoot === null) checkoutRoot = (await resolveRepoRoot()).root;
  return checkoutRoot;
}

export function claudeTtyProvider(): ProviderRegistration {
  return {
    id: PROVIDER_ID,
    label: PROVIDER_LABEL,
    description: "The genuine interactive Claude Code CLI, driven in a PTY",
    icon: PROVIDER_ICON,
    /**
     * Equal keys share one discovery. Without a key the daemon falls back to `["target", cwd]` and
     * spawns a throwaway adapter for every distinct workspace directory — and every worktree is one
     * — to fetch a catalogue that is compiled into the adapter and identical in all of them.
     *
     * It is the adapter's build rather than a bare constant, so an adapter rebuilt with a different
     * model list is discovered again instead of serving the old one for the rest of the daemon's
     * life. Nothing else invalidates it: the daemon refetches on an explicit refresh and marks
     * catalogues stale when the settings snapshot is refreshed, and otherwise holds what it has.
     *
     * This is its own IPC call on essentially every snapshot read, so it is one `stat` and no more.
     */
    async getCatalogCacheKey() {
      const root = await resolveCheckoutRoot();
      if (root === null) return `${PROVIDER_ID}:unresolved`;
      const entry = adapterEntryPath(root);
      try {
        const built = await stat(entry);
        return `${entry}:${built.mtimeMs}:${built.size}`;
      } catch {
        // One shared key rather than none, so an adapter that is not built yet fails discovery once
        // instead of once per workspace; the build that fixes it changes the key and refreshes all.
        return `${entry}:unbuilt`;
      }
    },
    /**
     * The command names the adapter inside the checkout this plugin was installed from, which is
     * only knowable at runtime, so the ACP shim is built per connection rather than at registration.
     */
    async connect(request) {
      const repo = await resolveRepoRoot();
      if (repo.root === null) throw new Error(repo.problem);
      const details = toolCallDetails();
      const connection = await runAcpProvider({
        id: PROVIDER_ID,
        label: PROVIDER_LABEL,
        command: [adapterBinaryPath(repo.root)],
        acpOptions: { waitForInitialCommands: true, initialCommandsTimeoutMs: INITIAL_COMMANDS_TIMEOUT_MS },
        transformers: [details.transformer],
      }).connect(request);
      // The steer fallback goes innermost, because it stands in for the bridge, so the cards wrap a
      // connection that already answers a steer.
      return details.wrap(withSteerFallback(connection, request.capabilities));
    },
  };
}
