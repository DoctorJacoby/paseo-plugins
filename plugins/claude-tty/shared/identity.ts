/**
 * What this copy of the plugin is called, and everything derived from it.
 *
 * Two copies can be installed side by side — a stable one the working agents sit on, and an
 * experimental one that can be reloaded all day without stopping them (#38). The daemon keys
 * plugins, providers, surfaces and settings screens by ID and refuses a provider ID something
 * else already holds, so every one of those has to differ between the two, along with the
 * adapter's state directory, which is a path rather than an ID and would otherwise be shared.
 *
 * They all come from the two literals below, so a variant is `pnpm identity <id>` in a second
 * checkout rather than a hunt through the tree for the names that happen to collide.
 * `scripts/set-identity.mjs` rewrites them, `paseo-plugin.json`'s `id`, and the adapter's own
 * copy in `apps/claude-tty-acp/src/constants.ts`; `pnpm identity --check` says whether the
 * four agree, which is the thing a hand edit got wrong.
 *
 * Env var names are deliberately *not* in here. `CLAUDE_TTY_ACP_STATE_DIR`,
 * `CLAUDE_TTY_ACP_IDLE_TIMEOUT_MS` and `CLAUDE_TTY_HOST_SESSION` are knobs a person or a host
 * sets, not identities the daemon keys on, and a variant that quietly stopped reading the one
 * documented somewhere else would be worse than one that shares it.
 */

/** The plugin ID, which is `paseo-plugin.json`'s `id` and the provider ID with it. */
export const PLUGIN_ID = "claude-tty";

/** What it is called in the sidebar, the settings screen, the command centre and the provider list. */
export const PLUGIN_LABEL = "Claude TTY";

/**
 * The adapter's state directory, under `$XDG_STATE_HOME`: sessions, locks, card answers and the
 * adapter log. Mirrored in `apps/claude-tty-acp/src/constants.ts` as `APP_NAME`, which the plugin
 * cannot import — it runs in the daemon and the adapter is a package of its own.
 *
 * Not `ADAPTER_BINARY_NAME` in `server/paths.ts`, which stays `claude-tty-acp` whatever this is:
 * that one is the name of a directory in this checkout and of the executable in it, and neither
 * moves when the plugin is renamed.
 */
export const ADAPTER_STATE_DIRECTORY = `${PLUGIN_ID}-acp`;
