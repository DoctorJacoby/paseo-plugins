import { execFile } from "node:child_process";
import { access } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { writeLog } from "./log.ts";

const run = promisify(execFile);

/** Where an agent session runs, and the paths that follow from it. */
export type Placement = {
  /** Claude runs in this checkout's container rather than beside the adapter. */
  readonly boxed: boolean;
  /** The checkout the box belongs to; the adapter's own cwd for a host session. */
  readonly root: string;
  /** The `~/.claude` this session's Claude writes into, as this host sees it, or nothing for Claude's own default. */
  readonly configDir: string | undefined;
  /** Where a launch's runtime files go, so that Claude can read them; nothing leaves the caller's choice alone. */
  readonly runtimeRoot: string | undefined;
  /** What runs a node script Claude launches — the hook client. The adapter's own node is this host's, which a box does not have. */
  readonly nodeCommand: string;
  /** Why this session is not in a box, for the log. Empty for one that is. */
  readonly reason: string;
  /** A path this host wrote, as the process running Claude sees it. */
  guest(hostPath: string): string;
  /** A path Claude reported — its transcript, say — as this host sees it. */
  host(guestPath: string): string;
  /** The command line that starts Claude with these arguments. */
  launch(args: string[]): { file: string; args: string[]; env: NodeJS.ProcessEnv };
  /** Everything that has to exist before Claude is started: for a box, the box. */
  prepare(): Promise<void>;
};

/**
 * The environment variable that takes the host for one agent, whatever the allowlist says. Paseo
 * puts `paseo run --env` into the adapter's environment, which is how a spawn passes it in.
 */
export const HOST_SESSION_VARIABLE = "CLAUDE_TTY_HOST_SESSION";

/**
 * The host will run no session in this working directory. Its own class because the answer is a
 * decision rather than a fault: nothing retries it, and it is reported to whoever spawned in the
 * host's words, where any other failure here is this adapter's own problem.
 */
export class SessionRefused extends Error {
  override readonly name = "SessionRefused";
}

/** The host's answer is a few file reads and a walk of one repository's worktrees. */
const PLACEMENT_TIMEOUT_MS = 30_000;
/** Starting a box builds its image the first time a project is boxed, which is minutes rather than seconds. */
const START_TIMEOUT_MS = 10 * 60_000;
/** What the box image calls its node, which is not the path this adapter's own node has. */
const BOX_NODE = "node";
/** The box's own Claude, on its PATH. `CLAUDE_BIN` names one of this host's and means nothing in there. */
const BOX_CLAUDE = "claude";

/**
 * Where a session with this working directory runs, asked of the host and obeyed.
 *
 * The decision is the host's alone: `toolchain-box session` reads it from the projects file and the
 * allowlist in dotfiles, never from the working tree, because a box can write its own tree and
 * would otherwise be able to talk its way onto the host. Nothing here second-guesses that answer.
 *
 * Throws when the host refuses, which is what an unboxed project with no host workspace gets.
 */
export async function resolvePlacement(cwd: string, env: NodeJS.ProcessEnv = process.env): Promise<Placement> {
  if (env[HOST_SESSION_VARIABLE]?.trim() === "1") {
    return hostPlacement(cwd, `${HOST_SESSION_VARIABLE}=1 was passed to this agent`);
  }
  const command = await toolchainBox(env);
  // No toolchain-box is no policy, and the policy and the tool ship in one repository, so its
  // absence is this machine not having boxes at all rather than a session to refuse.
  if (!command) return hostPlacement(cwd, "this host has no toolchain-box to ask");
  const answer = await ask(command, cwd);
  switch (answer.placement) {
    case "box":
      return boxPlacement(command, answer.root ?? cwd, answer["agent-home"] ?? "", answer["guest-home"] ?? "");
    case "host":
      return hostPlacement(cwd, answer.reason ?? "the host allows a session here");
    case "refuse":
      throw new SessionRefused(refusal(cwd, answer.reason ?? ""));
    default:
      throw new Error(`${command} session ${cwd} answered '${answer.placement ?? ""}', which is not a placement this adapter knows`);
  }
}

function refusal(cwd: string, reason: string): string {
  return [
    `${cwd} has no session box, so running an agent there would run it on this host, with this account's keys in reach.`,
    reason,
    "The paved road is to box the project: add its main checkout to toolchain-box/projects in dotfiles and give it a paseo/toolchain-box.conf (kobe-work/work-organisation#56 is the onboarding).",
    `To keep a workspace on the host on purpose, list it in toolchain-box/sessions beside that file; to take the host for one agent, spawn it with ${HOST_SESSION_VARIABLE}=1.`,
  ].join(" ");
}

async function ask(command: string, cwd: string): Promise<Record<string, string>> {
  let stdout: string;
  try {
    ({ stdout } = await run(command, ["session", cwd], { timeout: PLACEMENT_TIMEOUT_MS, encoding: "utf8" }));
  } catch (error) {
    throw new Error(`Could not ask ${command} where a session in ${cwd} runs: ${errorMessage(error)}`);
  }
  const answer: Record<string, string> = {};
  for (const line of stdout.split("\n")) {
    const field = /^([a-z][a-z-]*) (.+)$/.exec(line.trim());
    if (field) answer[field[1]!] = field[2]!;
  }
  return answer;
}

/** The placement of a session nobody resolved one for: Claude beside the adapter, exactly as before boxing. */
export function unboxedPlacement(cwd: string): Placement {
  return hostPlacement(cwd, "no placement was resolved for this session");
}

function hostPlacement(root: string, reason: string): Placement {
  const identity = (value: string) => value;
  return {
    boxed: false,
    root,
    configDir: undefined,
    runtimeRoot: undefined,
    nodeCommand: process.execPath,
    reason,
    guest: identity,
    host: identity,
    launch: (args) => ({ file: process.env.CLAUDE_BIN || "claude", args, env: process.env }),
    prepare: async () => undefined,
  };
}

function boxPlacement(command: string, root: string, agentHome: string, guestHome: string): Placement {
  if (!path.isAbsolute(agentHome) || !path.isAbsolute(guestHome)) {
    throw new Error(`${command} said ${root} is boxed but named its agent home '${agentHome}' inside the box at '${guestHome}'`);
  }
  return {
    boxed: true,
    root,
    configDir: agentHome,
    // Claude reads its settings, its hook client and its prompt attachments out of the runtime
    // directory, and in a box it can read none of this host's temporary directory. The agent home
    // is the one place both sides can write, being a host directory the box mounts.
    runtimeRoot: path.join(agentHome, "paseo"),
    nodeCommand: BOX_NODE,
    reason: "",
    guest: (hostPath) => rebase(hostPath, agentHome, guestHome),
    host: (guestPath) => rebase(guestPath, guestHome, agentHome),
    // `toolchain-box exec` and not a podman command line of this adapter's own. It resolves the
    // checkout again from the host's own records, starts the box, forwards the environment through
    // its deny list, and — because `podman exec` proxies no signals — leaves behind the watchdog
    // that stops the process tree inside the box once this process is gone. Reimplementing that
    // here would be a second copy of the thing that keeps a killed session from leaving an agent
    // running in a container.
    launch: (args) => ({
      file: command,
      args: ["exec", "--", BOX_CLAUDE, ...args],
      // The wait-gate is for a toolchain command an agent runs before `pnpm install` has finished.
      // A session has nothing to wait for — it is the thing that would do the waiting — and a
      // start held past the handshake window is a session that never comes up.
      env: { ...process.env, TOOLCHAIN_BOX_NO_WAIT: "1" },
    }),
    // A boxed project whose box will not start is a failure to say out loud, never a quiet session
    // on the host. `--implicit` so that a box Paseo tore down with its worktree stays torn down.
    prepare: async () => {
      try {
        await run(command, ["up", "--implicit", root], { timeout: START_TIMEOUT_MS, encoding: "utf8" });
      } catch (error) {
        throw new Error(`The session box for ${root} would not start, so there is nowhere to run this session: ${errorMessage(error)}`);
      }
    },
  };
}

/** Only what lies inside the mounted directory moves; the checkout itself is at the same path on both sides. */
function rebase(target: string, from: string, to: string): string {
  const normalized = path.normalize(target);
  if (normalized !== from && !normalized.startsWith(`${from}${path.sep}`)) return target;
  return path.join(to, path.relative(from, normalized));
}

/**
 * The host's own copy, preferred over whatever is on the daemon's PATH: the answer decides whether
 * an agent runs with this account's credentials in reach, so it comes from the installed tool.
 */
async function toolchainBox(env: NodeJS.ProcessEnv): Promise<string | null> {
  const configured = env.TOOLCHAIN_BOX_BIN?.trim();
  if (configured) return configured;
  const installed = path.join(env.HOME || os.homedir(), ".local", "bin", "toolchain-box");
  if (await access(installed).then(() => true, () => false)) return installed;
  writeLog({ level: "warn", message: "No toolchain-box on this host; sessions run on the host as they did before boxing", expected: installed });
  return null;
}

function errorMessage(error: unknown): string {
  const details = error as { stderr?: string };
  const stderr = typeof details.stderr === "string" ? details.stderr.trim() : "";
  const message = error instanceof Error ? error.message : String(error);
  return stderr ? `${message}\n${stderr}` : message;
}
