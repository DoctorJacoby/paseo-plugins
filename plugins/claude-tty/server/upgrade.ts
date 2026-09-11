import { readFile } from "node:fs/promises";
import path from "node:path";
import type { PaseoApi } from "@getpaseo/client";
import type { StatusPayload } from "../shared/contracts.ts";
import { ADAPTER_BINARY_NAME, daemonConfigPath, type Env } from "./paths.ts";
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
