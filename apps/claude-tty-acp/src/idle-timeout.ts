import { readFile } from "node:fs/promises";
import { writeLog } from "./log.ts";

/**
 * These three are mirrored by `plugins/claude-tty/shared/settings.ts`, which defines the settings
 * document read below; the adapter is bundled from its own package and cannot import it.
 * Keep the two copies in step: a `MAX_IDLE_TIMEOUT_MS` that drifts lets the plugin save a value the
 * adapter then refuses.
 */
export const IDLE_TIMEOUT_ENV = "CLAUDE_TTY_ACP_IDLE_TIMEOUT_MS";
export const DEFAULT_IDLE_TIMEOUT_MS = 60 * 60 * 1_000;
export const MAX_IDLE_TIMEOUT_MS = 2_147_483_647;

export type Env = Record<string, string | undefined>;

let settingsFile: string | null = null;

/**
 * Paseo keeps this setting in the host's own plugin settings store, whose layout is the daemon's
 * business, so the plugin resolves the path and passes it at spawn rather than the adapter guessing
 * at one. An adapter run outside Paseo is given none and has only the environment variable.
 */
export function useSettingsFile(filePath: string | null): void {
  settingsFile = filePath;
}

/**
 * Decimal integers only: `Number` also takes `0x1c` and `1e3`, and a timeout is not a place to guess
 * what someone meant.
 */
export function parseIdleTimeout(raw: unknown): number | null {
  if (typeof raw === "number") {
    return Number.isSafeInteger(raw) && raw >= 0 && raw <= MAX_IDLE_TIMEOUT_MS ? raw : null;
  }
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (!/^\d+$/.test(trimmed)) return null;
  const value = Number(trimmed);
  return Number.isSafeInteger(value) && value <= MAX_IDLE_TIMEOUT_MS ? value : null;
}

/** Null when nothing is set, which is what lets the plugin's setting apply; a malformed value is reported rather than obeyed. */
export function idleTimeoutFromEnv(env: Env = process.env): number | null {
  const raw = env[IDLE_TIMEOUT_ENV]?.trim();
  if (!raw) return null;
  const value = parseIdleTimeout(raw);
  if (value !== null) return value;
  // Refusing to start over this would take every session on the host down for one bad string.
  writeLog({
    level: "warn",
    message: `Ignored ${IDLE_TIMEOUT_ENV}: it must be an integer from 0 through ${MAX_IDLE_TIMEOUT_MS} milliseconds`,
    value: raw,
  });
  return null;
}

/**
 * The host writes `{ version, values }`, and the version is the plugin's schema rather than this
 * file's contract: a document whose values still carry a usable `idleTimeoutMs` is honoured whatever
 * it says, and one that does not falls back like any other unreadable document.
 */
async function idleTimeoutFromSettings(filePath: string): Promise<number | null> {
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(filePath, "utf8"));
  } catch (error) {
    // No file is the normal state until someone changes the setting in Paseo.
    if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") {
      writeLog({ level: "warn", message: "Ignored an unreadable Claude TTY settings document", file: filePath, error: errorMessage(error) });
    }
    return null;
  }
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return null;
  const values = (raw as { values?: unknown }).values;
  if (values === null || typeof values !== "object" || Array.isArray(values)) return null;
  const value = parseIdleTimeout((values as Record<string, unknown>).idleTimeoutMs);
  if (value === null) {
    writeLog({ level: "warn", message: "Ignored an out-of-range idle timeout in the Claude TTY settings document", file: filePath });
    return null;
  }
  return value;
}

/**
 * The environment variable is the standalone knob and wins, so a host that sets it keeps its value
 * whatever the settings screen says. This is read per suspension rather than once at startup, so a
 * change made in Paseo reaches sessions that are already connected.
 */
export async function readIdleTimeout(env: Env = process.env, filePath: string | null = settingsFile): Promise<number> {
  const configured = idleTimeoutFromEnv(env) ?? (filePath === null ? null : await idleTimeoutFromSettings(filePath));
  return configured ?? DEFAULT_IDLE_TIMEOUT_MS;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
