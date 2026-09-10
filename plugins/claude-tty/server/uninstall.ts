import { rm } from "node:fs/promises";
import type { RemoveStatePayload } from "../shared/contracts.ts";
import { defaultStateDirectory } from "./paths.ts";
import { messageOf } from "./checkout.ts";
import { readState } from "./sessions.ts";

/**
 * The provider goes with the plugin now, so removing this plugin is `paseo plugin remove claude-tty`
 * and nothing here. What survives that is the state directory — the saved sessions the adapter
 * resumes from — which nothing else offers to delete and which no open session may be holding.
 */
export async function removeState(): Promise<RemoveStatePayload> {
  const stateDirectory = defaultStateDirectory();
  const held = (await readState()).sessions.filter((session) => session.lock?.live === true);
  if (held.length > 0) {
    const subject = held.length === 1 ? "A session is still open" : `${held.length} sessions are still open`;
    throw new Error(`${subject} on this host. Close ${held.length === 1 ? "it" : "them"} before removing ${stateDirectory}.`);
  }
  try {
    await rm(stateDirectory, { recursive: true, force: true });
  } catch (error) {
    throw new Error(`Could not remove ${stateDirectory}: ${messageOf(error)}`);
  }
  return { detail: `Removed ${stateDirectory}. Existing agents will not resume their Claude conversations.` };
}
