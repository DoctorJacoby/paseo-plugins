import { randomUUID } from "node:crypto";
import { link, mkdir, readFile, rm, rmdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { PaseoApi } from "@getpaseo/client";
import type { StatusPayload } from "../shared/contracts.ts";
import { parseIdleTimeout, settingsDocument } from "../shared/settings.ts";
import { messageOf } from "./checkout.ts";
import { ADAPTER_BINARY_NAME, daemonConfigPath, legacySettingsFilePath, settingsFilePath, type Env } from "./paths.ts";
import { listAgents } from "./sessions.ts";

/**
 * The ID the adapter was registered under before this plugin owned the provider. It is also the real
 * Trae CLI's, so an entry holding it is only this adapter's when its command says so.
 */
export const LEGACY_PROVIDER_ID = "traecli";

export type LegacyProvider = NonNullable<StatusPayload["legacyProvider"]>;

/**
 * Nothing removes the entry an older install wrote, so Paseo lists Claude TTY twice after an upgrade.
 * It is reported rather than removed: an agent started on it cannot resume once it is gone, and
 * whether those agents are finished with is not something the plugin can know.
 */
export async function readLegacyProvider(paseo: PaseoApi, env: Env = process.env): Promise<LegacyProvider | null> {
  const configFile = daemonConfigPath(env);
  let entry: unknown;
  try {
    const config = JSON.parse(await readFile(configFile, "utf8")) as { agents?: { providers?: Record<string, unknown> } };
    entry = config.agents?.providers?.[LEGACY_PROVIDER_ID];
  } catch {
    // A configuration that cannot be read is already the checkout's problem to report.
    return null;
  }
  const executable = commandOf(entry)?.[0];
  if (executable === undefined || path.basename(executable) !== ADAPTER_BINARY_NAME) return null;
  const agents = await listAgents(paseo);
  return {
    id: LEGACY_PROVIDER_ID,
    configFile,
    command: executable,
    // A partial count would read as "safe to remove" exactly when it is least likely to be.
    agents: agents.complete ? agents.entries.filter(isOnLegacyProvider).length : null,
  };
}

function commandOf(entry: unknown): string[] | null {
  if (entry === null || typeof entry !== "object" || Array.isArray(entry)) return null;
  const command = (entry as { command?: unknown }).command;
  return Array.isArray(command) && command.every((part) => typeof part === "string") ? command : null;
}

function isOnLegacyProvider(entry: unknown): boolean {
  if (entry === null || typeof entry !== "object") return false;
  const agent = (entry as { agent?: unknown }).agent;
  return agent !== null && typeof agent === "object" && (agent as { provider?: unknown }).provider === LEGACY_PROVIDER_ID;
}

/**
 * An older install kept the idle timeout in a file of its own, and the host's store starts from the
 * schema's defaults, so a chosen value would quietly go back to an hour. The store reads its file
 * afresh on every read and write, so writing the document here is all the settings screen and the
 * adapter need to see it.
 *
 * It only ever creates a document: a value saved in Paseo in the meantime wins. Once the host has
 * one, the old file has nothing left to say and is removed, which also keeps a reinstall — which
 * starts from defaults again — from bringing a stale value back. Never throws; it runs unawaited.
 */
export async function carryOverIdleTimeout(env: Env = process.env): Promise<void> {
  const legacyFile = legacySettingsFilePath(env);
  let raw: string;
  try {
    raw = await readFile(legacyFile, "utf8");
  } catch (error) {
    if (!hasCode(error, "ENOENT")) console.warn(`[claude-tty] Could not read ${legacyFile}: ${messageOf(error)}`);
    return;
  }

  // The old plugin read anything unusable as the default, which is also where the store starts.
  const value = legacyIdleTimeout(raw);
  if (value !== null) {
    try {
      if (await createSettingsDocument(settingsFilePath(env), value)) {
        console.log(`[claude-tty] Carried the idle timeout (${value}ms) over from ${legacyFile}.`);
      }
    } catch (error) {
      console.warn(`[claude-tty] Could not carry the idle timeout over from ${legacyFile}, so it is kept for the next start: ${messageOf(error)}`);
      return;
    }
  }

  try {
    await rm(legacyFile, { force: true });
  } catch (error) {
    console.warn(`[claude-tty] Could not remove ${legacyFile}: ${messageOf(error)}`);
    return;
  }
  // Only ever empty by now unless something else put a file there, in which case it stays.
  await rmdir(path.dirname(legacyFile)).catch(() => undefined);
}

/** The old plugin wrote `{ version: 1, settings }` and also accepted the settings bare. */
function legacyIdleTimeout(raw: string): number | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const settings = (parsed as { settings?: unknown }).settings ?? parsed;
  if (settings === null || typeof settings !== "object" || Array.isArray(settings)) return null;
  return parseIdleTimeout((settings as Record<string, unknown>).idleTimeoutMs);
}

/**
 * Written the way the store writes it, and linked into place rather than renamed: `link` refuses a
 * target that exists, so this cannot overwrite a document the store wrote after the check.
 */
async function createSettingsDocument(target: string, idleTimeoutMs: number): Promise<boolean> {
  const values = settingsDocument.schema.parse({ idleTimeoutMs });
  const temporary = `${target}.${randomUUID()}.tmp`;
  await mkdir(path.dirname(target), { recursive: true });
  try {
    await writeFile(temporary, JSON.stringify({ version: settingsDocument.version, values }), { mode: 0o600 });
    try {
      await link(temporary, target);
    } catch (error) {
      if (hasCode(error, "EEXIST")) return false;
      throw error;
    }
    return true;
  } finally {
    await rm(temporary, { force: true });
  }
}

function hasCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}
