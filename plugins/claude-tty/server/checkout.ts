import { access, constants, readFile } from "node:fs/promises";
import { PLUGIN_ID, adapterManifestPath, daemonConfigPath, repoRootFromPluginPath, type Env } from "./paths.ts";

export type RepoRoot = { root: string; problem: null } | { root: null; problem: string };

/**
 * The plugin manages the adapter in the checkout it was installed from, and nothing in the plugin
 * runtime says where that is: the server bundle is evaluated from a string, so it has neither
 * `__dirname` nor a usable `import.meta`, and the daemon's initialize message carries only the
 * plugin ID. The daemon configuration is the one record of the path, and it is read from disk
 * rather than asked for over `paseo.config.get()` because the daemon connects the provider before
 * any RPC has handed the plugin a `PaseoApi`.
 */
export async function resolveRepoRoot(env: Env = process.env): Promise<RepoRoot> {
  const configPath = daemonConfigPath(env);
  let entry: { path?: unknown } | undefined;
  try {
    const config = JSON.parse(await readFile(configPath, "utf8")) as { plugins?: Record<string, { path?: unknown }> };
    entry = config.plugins?.[PLUGIN_ID];
  } catch (error) {
    return { root: null, problem: `Could not read ${configPath}: ${messageOf(error)}` };
  }
  if (typeof entry?.path !== "string") {
    return { root: null, problem: `${configPath} has no plugin entry for "${PLUGIN_ID}", so there is no checkout to manage.` };
  }
  const pluginPath = entry.path;
  const root = repoRootFromPluginPath(pluginPath);
  const manifest = adapterManifestPath(root);
  if (!(await fileExists(manifest))) {
    return { root: null, problem: `${manifest} does not exist, so ${pluginPath} is not a plugin directory inside a paseo-plugins checkout.` };
  }
  return { root, problem: null };
}

export async function fileExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

/** The first candidate the daemon could actually execute, which is what a spawn would pick. */
export async function firstExecutable(candidates: readonly string[]): Promise<string | null> {
  for (const candidate of candidates) {
    try {
      await access(candidate, constants.X_OK);
      return candidate;
    } catch {
      continue;
    }
  }
  return null;
}

export function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
