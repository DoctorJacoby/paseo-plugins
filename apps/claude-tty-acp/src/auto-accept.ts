import { readSettingsValues } from "./settings-document.ts";

/**
 * Paseo's own id for the toggle its built-in ACP provider shows, so the plugin provider's copy of it
 * reads as the same switch. The bridge turns a boolean config option into an agent feature of this id.
 */
export const AUTO_ACCEPT_CONFIG_ID = "auto_accept";

/**
 * These are mirrored by `plugins/claude-tty/shared/settings.ts`, which defines the document the host
 * stores; the adapter is bundled from its own package and cannot import it. Keep the two in step.
 */
export const AUTO_ACCEPT_SETTING = "autoAccept";
export const BYPASS_AUTO_ACCEPT_SETTING = "bypassAutoAccept";

const BYPASS_MODE = "bypassPermissions";

/**
 * What a session that nobody has switched either way does with a permission request. A Bypass
 * Permissions session takes its own setting when one is chosen, and every other session, or one whose
 * bypass setting says to inherit, takes the general one. Anything unreadable asks: an approval is not
 * something to hand out over a document this build does not understand.
 */
export function autoAcceptDefault(values: Record<string, unknown> | null, mode: string): boolean {
  if (values === null) return false;
  if (mode === BYPASS_MODE) {
    const bypass = values[BYPASS_AUTO_ACCEPT_SETTING];
    if (bypass === "on") return true;
    if (bypass === "off") return false;
  }
  return values[AUTO_ACCEPT_SETTING] === true;
}

/** Read per request rather than once, so a change made in Paseo reaches sessions that are already open. */
export async function readAutoAcceptDefault(mode: string, filePath?: string | null): Promise<boolean> {
  return autoAcceptDefault(await readSettingsValues(filePath), mode);
}
