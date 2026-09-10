import { runAcpProvider } from "@getpaseo/plugin/server/acp";
import type { ProviderRegistration } from "@getpaseo/plugin/server/provider";
import { PROVIDER_ID, PROVIDER_LABEL } from "../shared/provider.ts";
import { resolveRepoRoot } from "./checkout.ts";
import { adapterBinaryPath } from "./paths.ts";

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
     * The command names the adapter inside the checkout this plugin was installed from, which is
     * only knowable at runtime, so the ACP shim is built per connection rather than at registration.
     */
    async connect(request) {
      const repo = await resolveRepoRoot();
      if (repo.root === null) throw new Error(repo.problem);
      return runAcpProvider({
        id: PROVIDER_ID,
        label: PROVIDER_LABEL,
        command: [adapterBinaryPath(repo.root)],
        acpOptions: { waitForInitialCommands: true, initialCommandsTimeoutMs: INITIAL_COMMANDS_TIMEOUT_MS },
      }).connect(request);
    },
  };
}
