import path from "node:path";
import type { z } from "zod";
import {
  AuthoredCheckOffSchema,
  CheckOffSchema,
  type AuthoredChangeRequest,
  type AuthoredCheckOff,
  type CheckOff,
  type CheckOffChange,
  type ListedChangeRequest,
  type ListedHost,
  type ReviewerState,
  type ReviewRequest,
} from "../shared/inbox.ts";
import type { InboxTab } from "../shared/inbox-preferences.ts";
import { byTab } from "./inbox-tabs.ts";
import { readJson, writeJson } from "./json-file.ts";
import { oneAtATimePer } from "./one-at-a-time.ts";

const FILE = "inbox-check-offs.json";

/** Each tab's check-offs by the change request's URL, kept apart so a check-off on one tab leaves the other alone. */
type CheckOffs = { assigned: Record<string, CheckOff>; authored: Record<string, AuthoredCheckOff> };

/** The states only the other side brings about: being asked again, or an approval taken back. */
const RETURNING_STATES: readonly ReviewerState[] = ["requested", "unapproved"];

/**
 * What the viewer checked off each tab of the review list, which the forge knows nothing of.
 * A check-off holds only until the change request moves on, so each listing is followed to drop those that came back or left the list.
 */
export class InboxCheckOffsFile {
  readonly #file: string;
  readonly #changes = oneAtATimePer<string>();

  constructor(dataDirectory: string) {
    this.#file = path.join(dataDirectory, FILE);
  }

  async set({ tab, url, checkOff }: CheckOffChange): Promise<void> {
    await this.#change((checkOffs) => {
      const { [url]: _, ...rest } = checkOffs[tab];
      return { ...checkOffs, [tab]: checkOff === null ? rest : { ...rest, [url]: checkOff } };
    });
  }

  /** Follows a listing of every host, and answers the URLs still checked off on each tab. */
  async follow(hosts: readonly ListedHost[]): Promise<Record<InboxTab, Set<string>>> {
    const followed = await this.#change((checkOffs) => ({
      assigned: followListing(checkOffs.assigned, hosts, "assigned", (host) => host.assigned, assignedStillOff),
      authored: followListing(checkOffs.authored, hosts, "authored", (host) => host.authored, authoredStillOff),
    }));
    return { assigned: new Set(Object.keys(followed.assigned)), authored: new Set(Object.keys(followed.authored)) };
  }

  async #read(): Promise<CheckOffs> {
    const stored = byTab(await readJson<unknown>(this.#file));
    return { assigned: byUrl(stored.assigned, CheckOffSchema), authored: byUrl(stored.authored, AuthoredCheckOffSchema) };
  }

  async #change(update: (checkOffs: CheckOffs) => CheckOffs): Promise<CheckOffs> {
    return this.#changes(FILE, async () => {
      const before = await this.#read();
      const after = update(before);
      if (JSON.stringify(after) !== JSON.stringify(before)) await writeJson(this.#file, after);
      return after;
    });
  }
}

/**
 * Follows one tab's check-offs through a listing: `stillOff` answers what a listed one holds as, or null once it came back.
 * Those a host listed in full no longer has are dropped; those on a host that failed or has more than it listed are kept.
 */
function followListing<C, L extends ListedChangeRequest>(
  checkOffs: Record<string, C>,
  hosts: readonly ListedHost[],
  tab: InboxTab,
  listOf: (host: ListedHost) => readonly L[],
  stillOff: (checkOff: C, listed: L) => C | null,
): Record<string, C> {
  const listed = new Map(hosts.flatMap((host) => listOf(host).map((item) => [item.url, item] as const)));
  const complete = new Set<string | null>(hosts.filter((host) => host.error === null && !host.truncated[tab]).map((host) => host.host));
  const followed: Record<string, C> = {};
  for (const [url, checkOff] of Object.entries(checkOffs)) {
    const item = listed.get(url);
    const kept = item === undefined ? (complete.has(hostOf(url)) ? null : checkOff) : stillOff(checkOff, item);
    if (kept !== null) followed[url] = kept;
  }
  return followed;
}

/**
 * An assigned check-off comes back on a push, or on a state only the other side brings about.
 * Otherwise it keeps the state the reviewer is now in, so one they moved on themselves, by commenting, still comes back when they are asked again.
 */
function assignedStillOff(checkOff: CheckOff, request: ReviewRequest): CheckOff | null {
  const pushed = request.headSha !== "" && request.headSha !== checkOff.headSha;
  if (pushed || (RETURNING_STATES.includes(request.state) && request.state !== checkOff.state)) return null;
  return { headSha: checkOff.headSha, state: request.state };
}

/**
 * An authored check-off comes back on any news from its reviewers, never on the author's own push.
 * Any change to the newest review time counts, since a GitLab approval reset can lower it or clear it.
 */
function authoredStillOff(checkOff: AuthoredCheckOff, request: AuthoredChangeRequest): AuthoredCheckOff | null {
  return request.status === checkOff.status && request.latestReviewAt === checkOff.latestReviewAt ? checkOff : null;
}

/** One tab's check-offs as the file holds them, leaving out any the plugin no longer reads. */
function byUrl<T>(stored: unknown, schema: z.ZodType<T>): Record<string, T> {
  if (typeof stored !== "object" || stored === null) return {};
  const checkOffs: Record<string, T> = {};
  for (const [url, value] of Object.entries(stored)) {
    const parsed = schema.safeParse(value);
    if (parsed.success) checkOffs[url] = parsed.data;
  }
  return checkOffs;
}

function hostOf(url: string): string | null {
  try {
    return new URL(url).host.toLowerCase();
  } catch {
    return null;
  }
}
