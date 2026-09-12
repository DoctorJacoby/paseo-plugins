import os from "node:os";
import path from "node:path";
import { runCommand } from "./exec.ts";
import type { Env } from "./paths.ts";

/**
 * A session may run inside its checkout's container rather than beside the daemon, and then the
 * `~/.claude` holding its transcripts is that box's, not this account's. The box's one is a
 * directory of this host's that the box mounts, so the panel reads it from out here as before —
 * once it knows to look one level along.
 *
 * The host is the only thing asked, through the same `toolchain-box` the adapter obeys. Nothing is
 * read out of the checkout, which the box can write.
 */

/** The panel polls, and a checkout does not change boxes between two polls. */
const CACHE_MS = 60_000;
/** A resolution is a couple of file reads; the daemon kills a plugin RPC at thirty seconds. */
const TIMEOUT_MS = 5_000;

const cache = new Map<string, { at: number; home: string | null }>();

export async function boxedAgentHome(cwd: string, env: Env = process.env): Promise<string | null> {
  const cached = cache.get(cwd);
  if (cached && Date.now() - cached.at < CACHE_MS) return cached.home;
  const home = await ask(cwd, env);
  cache.set(cwd, { at: Date.now(), home });
  return home;
}

async function ask(cwd: string, env: Env): Promise<string | null> {
  const command = env.TOOLCHAIN_BOX_BIN?.trim() || path.join(env.HOME || os.homedir(), ".local", "bin", "toolchain-box");
  const result = await runCommand(command, ["session", cwd], { cwd: "/", timeoutMs: TIMEOUT_MS });
  // No toolchain-box, or a directory it will not answer for: this host keeps its sessions beside
  // the daemon, which is where the panel already looks.
  if (result.spawnError !== null || result.exitCode !== 0) return null;
  const answer = new Map<string, string>();
  for (const line of result.stdout.split("\n")) {
    const field = /^([a-z][a-z-]*) (.+)$/.exec(line.trim());
    if (field) answer.set(field[1]!, field[2]!);
  }
  if (answer.get("placement") !== "box") return null;
  const home = answer.get("agent-home");
  return home && path.isAbsolute(home) ? home : null;
}
