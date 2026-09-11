import type { PaseoApi } from "@getpaseo/client";
import type { StatusPayload } from "../shared/contracts.ts";
import { adapterBinaryPath, adapterEntryPath, claudeCandidates, defaultStateDirectory, settingsFilePath, type Env } from "./paths.ts";
import { IDLE_TIMEOUT_ENV, parseIdleTimeout } from "../shared/settings.ts";
import { fileExists, firstExecutable, resolveRepoRoot } from "./checkout.ts";
import { readSettings } from "./settings-store.ts";
import { readLegacyProvider } from "./upgrade.ts";

export async function readStatus(paseo: PaseoApi, env: Env = process.env): Promise<StatusPayload> {
  const [repo, claudeBinary, saved, legacyProvider] = await Promise.all([
    resolveRepoRoot(env),
    firstExecutable(claudeCandidates(env)),
    readSettings(env),
    readLegacyProvider(paseo, env),
  ]);
  const settings = {
    idleTimeoutMs: saved.idleTimeoutMs,
    file: settingsFilePath(env),
    envOverrideMs: envOverrideOf(env),
  };
  const common = {
    host: { node: process.version, claude: claudeBinary },
    stateDirectory: defaultStateDirectory(env),
    settings,
    legacyProvider,
  };

  if (repo.root === null) {
    return { repoRoot: null, problem: repo.problem, adapter: { binary: null, built: false }, ...common };
  }

  return {
    repoRoot: repo.root,
    problem: null,
    adapter: { binary: adapterBinaryPath(repo.root), built: await fileExists(adapterEntryPath(repo.root)) },
    ...common,
  };
}

/**
 * The adapter inherits this process's environment and lets the variable win over the settings file,
 * so a value set on the daemon makes the saved one moot. The daemon may still put one into a
 * session's own environment, which is invisible from here and is not reported.
 */
function envOverrideOf(env: Env): number | null {
  const raw = env[IDLE_TIMEOUT_ENV];
  return raw === undefined ? null : parseIdleTimeout(raw);
}
