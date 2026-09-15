import type { PaseoApi } from "@getpaseo/client";
import type { StatusPayload } from "../shared/contracts.ts";
import { claudeCandidates, defaultStateDirectory, settingsFilePath, type Env } from "./paths.ts";
import { IDLE_TIMEOUT_ENV, parseIdleTimeout } from "../shared/settings.ts";
import { firstExecutable } from "./checkout.ts";
import { resolveAdapter } from "./adapter.ts";
import { readLegacyProvider } from "./upgrade.ts";

export async function readStatus(paseo: PaseoApi, env: Env = process.env): Promise<StatusPayload> {
  const [adapter, claudeBinary, legacyProvider] = await Promise.all([
    resolveAdapter(env),
    firstExecutable(claudeCandidates(env)),
    readLegacyProvider(paseo, env),
  ]);

  return {
    repoRoot: adapter.checkout.root,
    // Advisory since the adapter's path can be set instead, so it is reported beside the adapter
    // rather than in front of everything: a host running a configured adapter has no checkout and
    // nothing wrong with it.
    checkoutProblem: adapter.checkout.problem,
    adapter: {
      binary: adapter.executable,
      source: adapter.source,
      built: adapter.built,
      problem: adapter.problem,
    },
    host: { node: process.version, claude: claudeBinary },
    stateDirectory: defaultStateDirectory(env),
    settings: { file: settingsFilePath(env), envOverrideMs: envOverrideOf(env) },
    legacyProvider,
  };
}

/**
 * The adapter inherits this process's environment and lets the variable win over the settings
 * document, so a value set on the daemon makes the saved one moot. The daemon may still put one into
 * a session's own environment, which is invisible from here and is not reported.
 */
function envOverrideOf(env: Env): number | null {
  const raw = env[IDLE_TIMEOUT_ENV];
  return raw === undefined ? null : parseIdleTimeout(raw);
}
