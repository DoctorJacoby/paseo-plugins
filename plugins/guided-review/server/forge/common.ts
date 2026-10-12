import type { ListedHost, Reviewer, ReviewStatus } from "../../shared/inbox.ts";
import type { ForgeUser } from "./port.ts";

/** What both forge adapters share: the caps on what they read, how an author with no account reads, how reviewers' states combine, and how a host that could not be listed reads. */

/** Cloning a large repository is the one call that can take minutes. */
export const CLONE_TIMEOUT_MS = 10 * 60_000;

/** Enough to understand a change; the guide does not need a hundred-and-first commit's message. */
export const MAX_COMMITS = 100;
export const MAX_LINKED_ISSUES = 25;
/** More open change requests from one branch than anyone would choose between. */
export const MAX_BRANCH_CHANGE_REQUESTS = 20;

/** How many reads a call that takes one per commit has out at once. */
export const COMMIT_READS_AT_ONCE = 6;

/** `map` over `items`, at most `limit` at a time, in `items`' order. */
export async function mapAtMost<T, R>(items: readonly T[], limit: number, map: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await map(items[index]!);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

/** What both forges show as the author of a change request whose account was deleted. */
export const GHOST: ForgeUser = { login: "ghost", name: null };

/** An author as the forge gave one, or the ghost when it gave none, as for a deleted account. */
export function userOf(author: { login: string; name?: string | null | undefined } | null | undefined): ForgeUser {
  return author ? { login: author.login, name: author.name ?? null } : GHOST;
}

/**
 * Where an authored change request stands from each reviewer's latest state, by the same rule on both forges.
 * A change request beats any approval, and an approval still standing beats one taken back.
 */
export function reviewStatusOf(reviewers: readonly Reviewer[]): ReviewStatus {
  const states = new Set(reviewers.map((reviewer) => reviewer.state));
  if (states.has("changes-requested")) return "changes-requested";
  if (states.has("approved")) return "approved";
  if (states.has("unapproved")) return "approval-reset";
  if (states.has("commented")) return "commented";
  return states.has("requested") ? "waiting" : "unreviewed";
}

/** The latest of some ISO times, as the forge wrote it; null for none. */
export function latestOf(times: readonly string[]): string | null {
  return times.reduce<string | null>((latest, at) => (latest === null || Date.parse(at) > Date.parse(latest) ? at : latest), null);
}

/** A host that could not be listed, with why. */
export function unlistedHost(forge: ListedHost["forge"], host: string, error: string): ListedHost {
  return { forge, host, assigned: [], authored: [], truncated: { assigned: false, authored: false }, error };
}
