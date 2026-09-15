import os from "node:os";
import path from "node:path";

export type Env = Record<string, string | undefined>;

export const PLUGIN_ID = "claude-tty";
export const ADAPTER_BINARY_NAME = "claude-tty-acp";
export const ADAPTER_ENTRY_NAME = "cli.js";

/**
 * The daemon configuration, which is the only record of where this plugin was installed from.
 * Mirrors the daemon's own `resolvePaseoHome`, whose `PASEO_HOME` the plugin process inherits.
 */
export function daemonConfigPath(env: Env = process.env): string {
  const home = env.PASEO_HOME?.trim() || "~/.paseo";
  return path.join(path.resolve(expandHome(home, env)), "config.json");
}

function expandHome(input: string, env: Env): string {
  const home = env.HOME || os.homedir();
  if (input === "~") return home;
  return input.startsWith("~/") ? path.join(home, input.slice(2)) : input;
}

/** Mirrors the adapter's own `defaultStateDirectory`; the plugin runs in the daemon and cannot import it. */
export function defaultStateDirectory(env: Env = process.env): string {
  const configured = env.CLAUDE_TTY_ACP_STATE_DIR?.trim();
  if (configured) return configured;
  const stateHome = env.XDG_STATE_HOME?.trim() || path.join(env.HOME || os.homedir(), ".local", "state");
  return path.join(stateHome, "claude-tty-acp");
}

/**
 * Plugin-owned persistence, the convention the root README documents for every plugin here.
 * Mirrored by `settingsFilePath` in `apps/claude-tty-acp/src/idle-timeout.ts`, which reads this file.
 */
export function settingsFilePath(env: Env = process.env): string {
  const base = env.XDG_CACHE_HOME?.trim() || path.join(env.HOME || os.homedir(), ".cache");
  return path.join(base, "paseo-plugins", PLUGIN_ID, "settings.json");
}

export function sessionsDirectory(stateDirectory: string): string {
  return path.join(stateDirectory, "sessions");
}

export function locksDirectory(stateDirectory: string): string {
  return path.join(stateDirectory, "locks");
}

/** Mirrors the adapter's own `claudeConfigDir`, which decides where Claude keeps its transcripts. */
export function claudeConfigDirectory(env: Env = process.env): string {
  const configured = env.CLAUDE_CONFIG_DIR?.trim();
  return configured || path.join(env.HOME || os.homedir(), ".claude");
}

/** Claude names a project directory after its working directory, with everything else punched out. */
export function projectDirectory(cwd: string, env: Env = process.env): string {
  return path.join(claudeConfigDirectory(env), "projects", cwd.replace(/[^a-zA-Z0-9]/g, "-"));
}

export function transcriptPath(cwd: string, claudeSessionId: string, env: Env = process.env): string {
  return path.join(projectDirectory(cwd, env), `${claudeSessionId}.jsonl`);
}

/** Every subagent a session runs has its own transcript here, and nowhere in the session's own. */
export function subagentsDirectory(cwd: string, claudeSessionId: string, env: Env = process.env): string {
  return path.join(projectDirectory(cwd, env), claudeSessionId, "subagents");
}

/** `plugins/claude-tty` sits two levels below the checkout whose adapter this plugin manages. */
export function repoRootFromPluginPath(pluginPath: string): string {
  return path.resolve(pluginPath, "..", "..");
}

export function adapterDirectory(repoRoot: string): string {
  return path.join(repoRoot, "apps", ADAPTER_BINARY_NAME);
}

export function adapterManifestPath(repoRoot: string): string {
  return path.join(adapterDirectory(repoRoot), "package.json");
}

export function adapterBinaryPath(repoRoot: string): string {
  return path.join(adapterDirectory(repoRoot), "bin", ADAPTER_BINARY_NAME);
}

/** The binary is a shell wrapper around this file, so its absence is what "not built yet" means. */
export function adapterEntryPath(repoRoot: string): string {
  return path.join(adapterDirectory(repoRoot), "dist", ADAPTER_ENTRY_NAME);
}

/** Where a bare command name would be found, in the order a shell would try. */
export function executableCandidates(command: string, env: Env = process.env): string[] {
  if (command.includes(path.sep)) return [path.resolve(command)];
  return (env.PATH ?? "")
    .split(path.delimiter)
    .filter((entry) => entry !== "")
    .map((entry) => path.join(entry, command));
}

/** `CLAUDE_BIN` wins over `PATH` for the adapter, so the plugin looks where the adapter would look. */
export function claudeCandidates(env: Env = process.env): string[] {
  const configured = env.CLAUDE_BIN?.trim();
  return configured ? [path.resolve(configured)] : executableCandidates("claude", env);
}
