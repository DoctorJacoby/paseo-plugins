import { stat } from "node:fs/promises";
import { runAcpProvider } from "@getpaseo/plugin/server/acp";
import type { ProviderRegistration } from "@getpaseo/plugin/server/provider";
import { PROVIDER_ID, PROVIDER_LABEL } from "../shared/provider.ts";
import { resolveAdapter } from "./adapter.ts";
import { adapterCommand, cardAnswersDirectory, defaultStateDirectory } from "./paths.ts";
import { withPermissionCards } from "./permission-bridge.ts";
import { sessionNotices } from "./session-notices.ts";
import { withSteerFallback } from "./steering.ts";
import { subagentSource } from "./subagents.ts";
import { withSubagentSessions } from "./subsessions.ts";
import { withCancelledToolCalls } from "./tool-call-outcomes.ts";
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
     * This is its own IPC call on essentially every snapshot read, so it stays at the settings
     * document and one `stat`: the document is read rather than cached because the executable it can
     * name is a setting, which — unlike the checkout — changes under a running plugin.
     */
    async getCatalogCacheKey() {
      const adapter = await resolveAdapter();
      if (adapter.buildWitness === null) return `${PROVIDER_ID}:unresolved`;
      try {
        const built = await stat(adapter.buildWitness);
        return `${adapter.buildWitness}:${built.mtimeMs}:${built.size}`;
      } catch {
        // One shared key rather than none, so an adapter that is not built yet fails discovery once
        // instead of once per workspace; the build that fixes it changes the key and refreshes all.
        return `${adapter.buildWitness}:unbuilt`;
      }
    },
    /**
     * The command names the adapter this host runs — the one its settings point at, or the one in the
     * checkout this plugin was installed from — and the settings document the host keeps, neither of
     * which is knowable before the plugin runs, so the ACP shim is built per connection rather than
     * at registration. That also makes a changed setting reach the next connection rather than only
     * the next daemon start.
     */
    async connect(request) {
      const adapter = await resolveAdapter();
      if (adapter.executable === null) throw new Error(adapter.problem!);
      const details = toolCallDetails();
      const notices = sessionNotices();
      const connection = await runAcpProvider({
        id: PROVIDER_ID,
        label: PROVIDER_LABEL,
        command: adapterCommand(adapter.executable),
        acpOptions: { waitForInitialCommands: true, initialCommandsTimeoutMs: INITIAL_COMMANDS_TIMEOUT_MS },
        transformers: [details.transformer, notices.transformer],
      }).connect(request);
      // The steer fallback goes innermost, because it stands in for the bridge. The notices go next:
      // what that wrapper injects -- a card the adapter has taken back -- has to travel out through
      // every wrapper above, the permission cards included, since each keeps state about the events it
      // sees. The cards go after, so the two wrappers outside read tool calls that already say what they
      // were. The subsessions go above those, so what the daemon is told this connection can do is what
      // the wrapper that emits the child sessions has already agreed to. The outcomes go outermost,
      // because an item the daemon will not accept has to be repaired wherever in the stack it was made.
      return withCancelledToolCalls(
        withSubagentSessions(
          withPermissionCards(
            details.wrap(notices.wrap(withSteerFallback(connection, request.capabilities))),
            cardAnswersDirectory(defaultStateDirectory()),
          ),
          subagentSource(),
          request.capabilities,
        ),
      );
    },
  };
}
