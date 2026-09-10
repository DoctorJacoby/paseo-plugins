import { defaultStateDirectory, subagentsDirectory } from "./paths.ts";
import { readSessionEntry } from "./sessions.ts";
import { isSafeStateFileStem } from "../shared/sessions.ts";
import { readSidecars, SubagentTranscript } from "./subagent-transcripts.ts";
import type { SubagentSource } from "./subsessions.ts";

/**
 * Where Claude keeps a session's subagents, on the disk the adapter writes to. The session the
 * daemon knows is the adapter's ACP session; which Claude session that is running on is recorded in
 * the adapter's state file and nowhere else, and it moves when the session compacts.
 */
export function subagentSource(): SubagentSource {
  return {
    async locate(nativeSessionId: string, cwd: string) {
      if (!isSafeStateFileStem(nativeSessionId)) return null;
      const entry = await readSessionEntry(defaultStateDirectory(), nativeSessionId);
      const claudeSessionId = entry?.claudeSessionId ?? null;
      if (claudeSessionId === null || !isSafeStateFileStem(claudeSessionId)) return null;
      return subagentsDirectory(entry?.cwd ?? cwd, claudeSessionId);
    },
    list: (directory) => readSidecars(directory),
    open: (directory, agentId) => new SubagentTranscript(directory, agentId),
  };
}
