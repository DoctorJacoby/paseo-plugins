import type { PaseoApi } from "@getpaseo/client";
import type { StatusPayload } from "../shared/contracts.ts";
import { MAX_IDLE_TIMEOUT_MS, parseIdleTimeout } from "../shared/settings.ts";
import { messageOf } from "./checkout.ts";
import { writeSettings } from "./settings-store.ts";
import { readStatus } from "./status.ts";

/**
 * The setting is the plugin's own and the adapter re-reads it per suspension, so the value reaches
 * sessions that are already connected rather than only the next adapter launch.
 */
export async function updateSettings(paseo: PaseoApi, idleTimeoutMs: number): Promise<StatusPayload> {
  if (parseIdleTimeout(idleTimeoutMs) === null) {
    throw new Error(`Idle timeout must be an integer from 0 through ${MAX_IDLE_TIMEOUT_MS} milliseconds.`);
  }
  try {
    await writeSettings({ idleTimeoutMs });
  } catch (error) {
    throw new Error(`Could not save the Claude TTY settings: ${messageOf(error)}`);
  }
  return readStatus(paseo);
}
