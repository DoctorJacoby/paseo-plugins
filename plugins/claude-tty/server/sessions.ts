import { readdir, readFile, rename, unlink } from "node:fs/promises";
import path from "node:path";
import type { PaseoApi } from "@getpaseo/client";
import type { SessionsPayload } from "../shared/contracts.ts";
import { lockOwnerRefusal, ownsLock, type LockOwnerRefusal, type ProcessIdentity } from "./lock-owner.ts";
import { defaultStateDirectory, locksDirectory, sessionsDirectory } from "./paths.ts";
import {
  LOCK_SUFFIX,
  SESSION_SUFFIX,
  attachAgents,
  isSafeStateFileStem,
  joinSessions,
  type SessionEntry,
  type SessionLock,
  type StateFile,
} from "../shared/sessions.ts";
import { runCommand } from "./exec.ts";
import { messageOf } from "./checkout.ts";

/** How long the adapter is given to close its session and release its lock of its own accord. */
const STOP_GRACE_MS = 10_000;
/** How long the kernel is given to reap a process that has been sent a signal it cannot refuse. */
const FORCE_GRACE_MS = 2_000;
const EXIT_POLL_MS = 100;
/**
 * Naming a session after its agent is a courtesy, and the daemon kills a plugin RPC at 30 seconds,
 * so the whole lookup is bounded well inside that rather than taking a stop down with it.
 */
const AGENT_BUDGET_MS = 3_000;
const AGENT_PAGE_SIZE = 200;
const AGENT_PAGE_LIMIT = 10;

export type StateReading = { stateDirectory: string; problem: string | null; sessions: SessionEntry[] };

/**
 * Two clients pressing Stop on one session must not both signal it: the adapter registers its
 * handler with `process.once`, so a second SIGTERM arriving mid-shutdown takes the default action
 * and kills it before it can release the lock.
 */
const stopsInFlight = new Map<string, Promise<SessionsPayload>>();

export async function listSessions(paseo: PaseoApi): Promise<SessionsPayload> {
  const reading = await readState();
  return {
    stateDirectory: reading.stateDirectory,
    problem: reading.problem,
    // The panel may be running on another machine, so elapsed time is measured against this clock.
    now: Date.now(),
    sessions: attachAgents(reading.sessions, (await listAgents(paseo)).entries),
  };
}

/** Only ever removes a lock the recorded process can no longer be holding. */
export async function releaseLock(paseo: PaseoApi, id: string): Promise<SessionsPayload> {
  const entry = await requireEntry(id);
  if (entry.lock === null) throw new Error(`Session ${id} holds no lock.`);
  if (entry.lock.live) throw new Error(`Process ${entry.lock.pid} still holds session ${id}. Stop it first.`);
  await unlink(path.join(locksDirectory(defaultStateDirectory()), `${id}${LOCK_SUFFIX}`));
  return listSessions(paseo);
}

/** Safe by construction: a live lock is never a candidate, so this needs no confirmation of its own. */
export async function releaseStaleLocks(paseo: PaseoApi): Promise<SessionsPayload> {
  const directory = locksDirectory(defaultStateDirectory());
  const stale = (await readState()).sessions.filter((entry) => entry.lock !== null && !entry.lock.live);
  for (const entry of stale) {
    await unlink(path.join(directory, `${entry.id}${LOCK_SUFFIX}`)).catch(() => undefined);
  }
  return listSessions(paseo);
}

/**
 * Stops the adapter process holding a session. Its own signal handler closes the session, which
 * stops the Claude PTY and releases the lock, so the persisted session and the Paseo agent both
 * survive and the next prompt resumes them.
 */
export function stopSession(paseo: PaseoApi, id: string): Promise<SessionsPayload> {
  const running = stopsInFlight.get(id);
  if (running !== undefined) return running;
  const attempt = runStop(paseo, id).finally(() => stopsInFlight.delete(id));
  stopsInFlight.set(id, attempt);
  return attempt;
}

async function runStop(paseo: PaseoApi, id: string): Promise<SessionsPayload> {
  const entry = await requireEntry(id);
  if (entry.lock === null || !entry.lock.live) throw new Error(`Session ${id} is not open, so there is nothing to stop.`);
  const lock = entry.lock;
  await requireOwner(lock, id);

  signal(lock.pid, "SIGTERM");
  if (!(await waitForExit(lock.pid, STOP_GRACE_MS))) {
    // The adapter may have exited and its PID been taken during the wait, so identity is proved again.
    const current = await identify(lock.pid);
    if (current !== null && ownsLock(current, lock)) {
      console.warn(`[claude-tty] Session ${id} did not close within ${STOP_GRACE_MS}ms; forcing process ${lock.pid}.`);
      signal(lock.pid, "SIGKILL");
      if (!(await waitForExit(lock.pid, FORCE_GRACE_MS))) throw new Error(`Process ${lock.pid} did not stop.`);
      // A forced process never ran its handler, so it leaves the lock behind for "Release lock".
      console.warn(`[claude-tty] Forced process ${lock.pid}; session ${id} may have left its lock behind.`);
    }
  }
  return listSessions(paseo);
}

/** Moves a session file aside rather than deleting it, so the failure can still be diagnosed. */
export async function quarantineSession(paseo: PaseoApi, id: string): Promise<SessionsPayload> {
  const entry = await requireEntry(id);
  if (!entry.corrupt) throw new Error(`Session ${id} is readable, so there is nothing to quarantine.`);
  const directory = sessionsDirectory(defaultStateDirectory());
  const source = path.join(directory, `${id}${SESSION_SUFFIX}`);
  await rename(source, `${source}.corrupt-${Date.now()}`);
  return listSessions(paseo);
}

async function requireOwner(lock: SessionLock, id: string): Promise<void> {
  const identity = await identify(lock.pid);
  if (identity === null) {
    throw new Error(`Could not read what process ${lock.pid} is running, so it was left alone.`);
  }
  const refusal = lockOwnerRefusal(identity, lock);
  if (refusal !== null) throw new Error(refusalMessage(refusal, lock.pid, id));
}

/** Every refusal names the process and says that nothing was signalled, because nothing was. */
function refusalMessage(refusal: LockOwnerRefusal, pid: number, id: string): string {
  switch (refusal) {
    case "zombie":
      return `Process ${pid} has already exited and is waiting to be reaped. Release the lock once it is gone.`;
    case "unknown-start":
      return `This host would not say when process ${pid} started, and without that a stop cannot tell the adapter from something that inherited its PID, so it was left alone.`;
    case "not-adapter":
    case "started-after-lock":
      return `Process ${pid} is not the adapter that took the lock on session ${id} — a PID outlives the process that earned it — so it was left alone.`;
  }
}

/** The decisions a mutation makes are local, so none of them wait on the daemon for agent titles. */
async function requireEntry(id: string): Promise<SessionEntry> {
  if (!isSafeStateFileStem(id)) throw new Error(`${id} is not a session in the state directory.`);
  const entry = (await readState()).sessions.find((candidate) => candidate.id === id);
  if (entry === undefined) throw new Error(`Session ${id} is no longer in the state directory.`);
  return entry;
}

export async function readState(): Promise<StateReading> {
  const root = defaultStateDirectory();
  const sessions = await readDirectory(sessionsDirectory(root));
  const locks = await readDirectory(locksDirectory(root));
  return {
    stateDirectory: root,
    problem: sessions.problem ?? locks.problem,
    sessions: joinSessions(sessions.files, locks.files, processIsAlive),
  };
}

/**
 * Titles are a courtesy: a daemon that stalls or pages forever costs them and nothing else. `complete`
 * says whether the last page was reached, for the callers that count rather than decorate.
 */
export async function listAgents(paseo: PaseoApi): Promise<{ entries: unknown[]; complete: boolean }> {
  const deadline = Date.now() + AGENT_BUDGET_MS;
  const entries: unknown[] = [];
  let cursor: string | undefined;
  try {
    for (let page = 0; page < AGENT_PAGE_LIMIT; page += 1) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) break;
      const result = await withinBudget(paseo.agents.list({ page: { limit: AGENT_PAGE_SIZE, cursor } }), remaining);
      const payload = result as { entries?: unknown; pageInfo?: { nextCursor?: string | null } };
      if (Array.isArray(payload.entries)) entries.push(...payload.entries);
      cursor = payload.pageInfo?.nextCursor ?? undefined;
      if (cursor === undefined) return { entries, complete: true };
    }
  } catch {
    return { entries, complete: false };
  }
  return { entries, complete: false };
}

/** The SDK waits a minute by default, which is twice as long as the RPC calling it is allowed to take. */
function withinBudget<T>(work: Promise<T>, budgetMs: number): Promise<T> {
  return Promise.race([
    work,
    new Promise<T>((_resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Timed out")), budgetMs);
      timer.unref();
    }),
  ]);
}

/** `/proc` where there is one, and `ps` on the hosts without it. */
async function identify(pid: number): Promise<ProcessIdentity | null> {
  return (await identifyFromProc(pid)) ?? identifyFromPs(pid);
}

async function identifyFromProc(pid: number): Promise<ProcessIdentity | null> {
  const stat = await readFile(`/proc/${pid}/stat`, "utf8").catch(() => null);
  const uptime = await readFile("/proc/uptime", "utf8").catch(() => null);
  if (stat === null || uptime === null) return null;
  // The command in `stat` is parenthesised and may itself contain spaces and brackets.
  const fields = stat.slice(stat.lastIndexOf(")") + 1).trim().split(/\s+/);
  const state = fields[0];
  const startTicks = Number(fields[19]);
  const secondsUp = Number(uptime.split(/\s+/)[0]);
  if (state === undefined || !Number.isFinite(startTicks) || !Number.isFinite(secondsUp)) return null;
  const zombie = state === "Z";
  const raw = await readFile(`/proc/${pid}/cmdline`, "utf8").catch(() => null);
  const command = raw === null ? "" : raw.replaceAll("\0", " ").trim();
  // A kernel thread has no command line of its own; let `ps` answer rather than call it foreign.
  if (command === "" && !zombie) return null;
  return {
    command,
    // USER_HZ is 100 on Linux whatever the kernel is configured to tick at.
    startedAt: Date.now() - secondsUp * 1_000 + startTicks * 10,
    zombie,
  };
}

async function identifyFromPs(pid: number): Promise<ProcessIdentity | null> {
  const started = await ps(pid, "lstart=");
  const stateAndArgs = await ps(pid, "state=,args=");
  if (stateAndArgs === null) return null;
  const [state = "", command = ""] = splitFirstWord(stateAndArgs);
  const startedAt = started === null ? Number.NaN : Date.parse(started);
  return {
    command,
    startedAt: Number.isFinite(startedAt) ? startedAt : null,
    zombie: state.startsWith("Z"),
  };
}

async function ps(pid: number, format: string): Promise<string | null> {
  const result = await runCommand("ps", ["-p", String(pid), "-o", format], { cwd: "/", timeoutMs: 5_000 });
  const output = result.stdout.trim();
  return result.exitCode === 0 && output !== "" ? output : null;
}

function splitFirstWord(line: string): [string, string] {
  const match = /^(\S+)\s+([\s\S]*)$/.exec(line.trim());
  return match === null ? [line.trim(), ""] : [match[1] ?? "", match[2] ?? ""];
}

function signal(pid: number, name: NodeJS.Signals): void {
  // `process.kill` reads 0 and negatives as process groups, and an unreadable lock is recorded as
  // pid -1, so the one number that must never reach here has a way of being written down.
  if (!Number.isInteger(pid) || pid <= 0) throw new Error(`${pid} is not a process this can signal.`);
  try {
    process.kill(pid, name);
  } catch (error) {
    const code = error instanceof Error && "code" in error ? error.code : null;
    // Already gone is the outcome this was asking for.
    if (code === "ESRCH") return;
    if (code === "EPERM") throw new Error(`Process ${pid} belongs to another user, so this daemon cannot signal it.`);
    throw new Error(`Could not signal process ${pid}: ${messageOf(error)}`);
  }
}

async function waitForExit(pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (processIsAlive(pid)) {
    if (Date.now() >= deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, EXIT_POLL_MS));
  }
  return true;
}

async function readDirectory(directory: string): Promise<{ files: StateFile[]; problem: string | null }> {
  let names: string[];
  try {
    names = await readdir(directory);
  } catch (error) {
    // A host that has never run a session has no state directory, which is not a problem to report.
    return { files: [], problem: isMissing(error) ? null : `${directory}: ${messageOf(error)}` };
  }
  const files = await Promise.all(
    names.map(async (name) => ({ name, contents: await readFile(path.join(directory, name), "utf8").catch(() => null) })),
  );
  return { files, problem: null };
}

/** Signal 0 the way the adapter checks it, so both agree on which locks are stale. */
function processIsAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error instanceof Error && "code" in error && error.code === "EPERM";
  }
}

function isMissing(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}
