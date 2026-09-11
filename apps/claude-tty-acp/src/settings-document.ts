import { readFile } from "node:fs/promises";
import { writeLog } from "./log.ts";

let settingsFile: string | null = null;

/**
 * Paseo keeps this plugin's settings in the host's own plugin settings store, whose layout is the
 * daemon's business, so the plugin resolves the path and passes it at spawn rather than the adapter
 * guessing at one. An adapter run outside Paseo is given none and has only its environment.
 */
export function useSettingsFile(filePath: string | null): void {
  settingsFile = filePath;
}

export function currentSettingsFile(): string | null {
  return settingsFile;
}

/**
 * The host writes `{ version, values }`, and the version is the plugin's schema rather than this
 * file's contract: each reader takes the value it knows from `values` whatever the version says, and
 * judges that value itself. Null is a document there is nothing to read from.
 */
export async function readSettingsValues(filePath: string | null = settingsFile): Promise<Record<string, unknown> | null> {
  if (filePath === null) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(filePath, "utf8"));
  } catch (error) {
    // No file is the normal state until someone changes a setting in Paseo.
    if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") {
      writeLog({ level: "warn", message: "Ignored an unreadable Claude TTY settings document", file: filePath, error: errorMessage(error) });
    }
    return null;
  }
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return null;
  const values = (raw as { values?: unknown }).values;
  if (values === null || typeof values !== "object" || Array.isArray(values)) return null;
  return values as Record<string, unknown>;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
