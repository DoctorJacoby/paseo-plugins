import { boxedAgentHome } from "./boxes.ts";
import { defaultStateDirectory, claudeConfigDirectory, subagentsDirectory } from "./paths.ts";
import { readSessionEntry } from "./sessions.ts";
import { isSafeStateFileStem } from "../shared/sessions.ts";
import { readSidecars, SubagentTranscript } from "./subagent-transcripts.ts";
import type { SubagentSource } from "./subsessions.ts";

/**
 * Where Claude keeps a session's subagents, on the disk the adapter writes to. The session the
 * daemon knows is the adapter's ACP session; which Claude session that is running on is recorded in
 * the adapter's state file and nowhere else, and it moves when the session compacts.
 *
 * Which `~/.claude` that disk is depends on where the session runs: a boxed session's is its box's,
 * asked of the host rather than recorded anywhere, because a checkout's box is the host's to say
 * and a state file could be describing a session that was moved into one since it was written.
 */
export function subagentSource(): SubagentSource {
  return {
    async locate(nativeSessionId: string, cwd: string) {
      if (!isSafeStateFileStem(nativeSessionId)) return null;
      const entry = await readSessionEntry(defaultStateDirectory(), nativeSessionId);
      const claudeSessionId = entry?.claudeSessionId ?? null;
      if (claudeSessionId === null || !isSafeStateFileStem(claudeSessionId)) return null;
      const sessionCwd = entry?.cwd ?? cwd;
      const configDir = (await boxedAgentHome(sessionCwd)) ?? claudeConfigDirectory();
      return subagentsDirectory(sessionCwd, claudeSessionId, process.env, configDir);
    },
    list: (directory) => readSidecars(directory),
    open: (directory, agentId) => new SubagentTranscript(directory, agentId),
  };
}
