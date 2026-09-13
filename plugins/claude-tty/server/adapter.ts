import { readFile } from "node:fs/promises";
import path from "node:path";
import { configuredAdapterExecutable } from "../shared/settings.ts";
import { fileExists, firstExecutable, resolveRepoRoot } from "./checkout.ts";
import { adapterBinaryPath, adapterBuildWitness, settingsFilePath, type Env } from "./paths.ts";

/** Where the executable came from: a path someone configured, or the checkout this plugin sits in. */
export type AdapterSource = "configured" | "checkout";

export type Adapter = {
  /** What the provider spawns, or null when neither the setting nor a checkout names one. */
  executable: string | null;
  source: AdapterSource | null;
  /** The checkout, for the panel and for the default. Advisory: the setting stands in for it. */
  checkout: { root: string | null; problem: string | null };
  /** The file whose existence and mtime say which build would run, or null with no executable. */
  buildWitness: string | null;
  built: boolean;
  /** Why this adapter cannot be run right now, phrased for the panel, or null when it can. */
  problem: string | null;
};

/**
 * Which adapter this plugin runs, which is a question it used to answer by derivation alone.
 *
 * The checkout is still the default, and still the whole answer for an installation from a clone
 * with nothing configured. What it is no longer is the *only* answer: an installation Paseo cloned
 * for itself lives in a directory Paseo owns and rewrites on every update, and the adapter there is
 * a native build behind a private path, so a host that builds the adapter somewhere of its own now
 * says where instead of being told its installation is unusable.
 *
 * So the checkout's own problem stops being fatal and becomes one reading among several. Nothing
 * here throws: every way this can fail is a sentence the panel shows, because the alternative is a
 * spawn failure whose stderr the ACP shim drops.
 */
export async function resolveAdapter(env: Env = process.env): Promise<Adapter> {
  const [configured, checkout] = await Promise.all([readConfiguredExecutable(env), resolveRepoRoot(env)]);
  const executable = configured === null ? defaultExecutable(checkout.root) : path.resolve(configured);
  const source: AdapterSource | null = executable === null ? null : configured === null ? "checkout" : "configured";

  if (executable === null) {
    return {
      executable: null,
      source: null,
      checkout,
      buildWitness: null,
      built: false,
      problem: `${checkout.problem} Set an adapter executable in this plugin's settings to run one from somewhere else.`,
    };
  }

  const buildWitness = adapterBuildWitness(executable);
  const built = await fileExists(buildWitness);
  return { executable, source, checkout, buildWitness, built, problem: await problemWith(executable, buildWitness, built, source) };
}

function defaultExecutable(root: string | null): string | null {
  return root === null ? null : adapterBinaryPath(root);
}

/**
 * Read in the order a spawn would find out, so the first thing said is the first thing wrong: a path
 * that is not there, then one that is there and cannot be executed, then an adapter that has not been
 * built. The last is only ever a checkout's, since a witness that is not the executable is one.
 */
async function problemWith(executable: string, buildWitness: string, built: boolean, source: AdapterSource | null): Promise<string | null> {
  if (!(await fileExists(executable))) {
    return source === "configured"
      ? `${executable} does not exist. Check the adapter executable in this plugin's settings.`
      : `${executable} does not exist, so this checkout is not one this plugin can run the adapter from.`;
  }
  if ((await firstExecutable([executable])) === null) return `${executable} is not executable.`;
  if (!built) return `${buildWitness} is not built — run the build in the checkout.`;
  return null;
}

/**
 * The setting, read off the document the host keeps, because the SDK gives the server runtime no way
 * to read a value back out of the store it registered — the same reason the adapter is handed this
 * path rather than the value. A document that is missing, unreadable or malformed is a host that has
 * configured nothing, which is the default rather than an error: the store writes the file only once
 * somebody saves, and refusing to run an adapter over a JSON parse would be the whole host down for it.
 */
async function readConfiguredExecutable(env: Env): Promise<string | null> {
  let document: unknown;
  try {
    document = JSON.parse(await readFile(settingsFilePath(env), "utf8"));
  } catch {
    return null;
  }
  if (document === null || typeof document !== "object" || Array.isArray(document)) return null;
  // `{ version, values }`, where the version is the schema's rather than the file format's, so each
  // reader takes the value it knows whatever the version says — which is how the adapter reads it too.
  const values = (document as { values?: unknown }).values;
  if (values === null || typeof values !== "object" || Array.isArray(values)) return null;
  return configuredAdapterExecutable((values as Record<string, unknown>).adapterExecutable);
}
