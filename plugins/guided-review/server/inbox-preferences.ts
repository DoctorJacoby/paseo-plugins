import path from "node:path";
import { InboxPreferencesSchema, type InboxPreferences } from "../shared/inbox-preferences.ts";
import { byTab } from "./inbox-tabs.ts";
import { readJson, writeJson } from "./json-file.ts";
import { oneAtATimePer } from "./one-at-a-time.ts";

const FILE = "inbox-preferences.json";

/**
 * Each tab's filters, sort and columns, kept in the data directory because a plugin client has no storage of its own.
 * They are the daemon's, so every client of it shares them.
 */
export class InboxPreferencesFile {
  readonly #file: string;
  readonly #writes = oneAtATimePer<string>();

  constructor(dataDirectory: string) {
    this.#file = path.join(dataDirectory, FILE);
  }

  async read(): Promise<InboxPreferences> {
    return InboxPreferencesSchema.parse(byTab(await readJson<unknown>(this.#file)));
  }

  async save(preferences: InboxPreferences): Promise<InboxPreferences> {
    const parsed = InboxPreferencesSchema.parse(preferences);
    await this.#writes(FILE, () => writeJson(this.#file, parsed));
    return parsed;
  }
}
