import { DEFAULT_INBOX_PREFERENCES, type AssignedPreferences, type InboxSortKey, type InboxTab } from "../shared/inbox-preferences.ts";
import {
  ReviewerStateSchema,
  ReviewStatusSchema,
  type AuthoredInboxItem,
  type Inbox,
  type InboxItem,
  type ListedChangeRequest,
  type ReviewerState,
  type ReviewStatus,
} from "../shared/inbox.ts";
import { numberLabel } from "../shared/reference.ts";

/** What every row of either tab has to be filtered by. */
export type ListedItem = ListedChangeRequest & { checkedOff: boolean };

/** What a tab's filters read of the preferences; the columns are the table's business. */
export type ListFilters<State extends string> = Pick<AssignedPreferences, "provider" | "hideDrafts" | "checkedOff" | "needsAttention" | "sort"> & {
  states: readonly State[];
};

/** How a tab reads its rows. */
export type TabRules<Item extends ListedItem, State extends string> = {
  /** Where a row stands, as the States filter reads it. */
  state(item: Item): State;
  needsAttention(item: Item): boolean;
  /** What the search looks in, besides the number as the forge writes it. */
  searched(item: Item): string[];
  /** What a row is called, one and many. */
  noun: readonly [string, string];
};

/**
 * Whether the reviewer has something to do on it: never reviewed, asked again, an approval the forge
 * took back, or the change moved on since their review.
 */
export function needsAttention(item: InboxItem): boolean {
  return item.state === "requested" || item.state === "unapproved" || item.changedSinceReview === true;
}

export const ASSIGNED_RULES: TabRules<InboxItem, ReviewerState> = {
  state: (item) => item.state,
  needsAttention,
  searched: (item) => [item.title, item.project, item.author],
  noun: ["review", "reviews"],
};

/**
 * Whether the author has something to do on their change request: changes asked for, a review since their last push, or failing CI.
 * An approval reset waits on the reviewer, not the author.
 */
export function authoredNeedsAttention(item: AuthoredInboxItem): boolean {
  return item.status === "changes-requested" || item.reviewedSinceLastPush === true || item.ci === "failure";
}

/** The author is always the viewer, so the search leaves their name out. */
export const AUTHORED_RULES: TabRules<AuthoredInboxItem, ReviewStatus> = {
  state: (item) => item.status,
  needsAttention: authoredNeedsAttention,
  searched: (item) => [item.title, item.project, ...item.reviewers.map((reviewer) => reviewer.name)],
  noun: ["change request", "change requests"],
};

/** Every word of `query` is in what the tab searches or the number as the forge writes it. */
export function matchesSearch<Item extends ListedItem>(rules: TabRules<Item, string>, item: Item, query: string): boolean {
  const words = query.toLowerCase().split(/\s+/).filter((word) => word !== "");
  const text = [...rules.searched(item), numberLabel(item.forge, item.number)].join(" ").toLowerCase();
  return words.every((word) => text.includes(word));
}

const SORT_VALUES: Record<InboxSortKey, (item: ListedItem) => number> = {
  updated: (item) => Date.parse(item.updatedAt),
  created: (item) => Date.parse(item.createdAt),
  size: (item) => item.additions + item.deletions,
};

/** URLs that skip the check-off filter, as with no rows held. */
const NONE_HELD: ReadonlySet<string> = new Set();

/**
 * The items the list shows, filtered as the preferences say and by the search, in their sort order; ties go to the latest update.
 * A `held` row is shown whether or not the check-off filter would take it, so a row just checked off or unchecked stays put.
 */
export function visibleItems<Item extends ListedItem, State extends string>(
  rules: TabRules<Item, State>,
  items: readonly Item[],
  preferences: ListFilters<State>,
  query: string,
  held = NONE_HELD,
): Item[] {
  const value = SORT_VALUES[preferences.sort.key];
  const direction = preferences.sort.descending ? -1 : 1;
  return items
    .filter((item) => matchesFilters(rules, item, preferences, query) && (held.has(item.url) || passesCheckOff(item, preferences)))
    .sort((a, b) => direction * (value(a) - value(b)) || SORT_VALUES.updated(b) - SORT_VALUES.updated(a));
}

/** How many checked-off items the list leaves out that every other filter and the search would show. */
export function hiddenCheckedOff<Item extends ListedItem, State extends string>(
  rules: TabRules<Item, State>,
  items: readonly Item[],
  preferences: ListFilters<State>,
  query: string,
  held = NONE_HELD,
): number {
  return items.filter((item) => item.checkedOff && !held.has(item.url) && !passesCheckOff(item, preferences) && matchesFilters(rules, item, preferences, query))
    .length;
}

/** The Assigned tab's default filters with only what needs the reviewer's attention kept, whatever the reviewer last set. */
const ATTENTION_FILTERS: AssignedPreferences = { ...DEFAULT_INBOX_PREFERENCES.assigned, needsAttention: true };

/** How many review requests need the reviewer's attention: the sidebar's count, which leaves their own change requests out. */
export function attentionCount(inbox: Inbox): number {
  return inbox.assigned.filter((item) => matchesFilters(ASSIGNED_RULES, item, ATTENTION_FILTERS, "") && passesCheckOff(item, ATTENTION_FILTERS)).length;
}

/** Whether the check-off filter shows the item, which a held row is not asked. */
export function passesCheckOff(item: ListedItem, preferences: Pick<ListFilters<string>, "checkedOff">): boolean {
  switch (preferences.checkedOff) {
    case "hide":
      return !item.checkedOff;
    case "show":
      return true;
    case "only":
      return item.checkedOff;
  }
}

function matchesFilters<Item extends ListedItem, State extends string>(rules: TabRules<Item, State>, item: Item, preferences: ListFilters<State>, query: string): boolean {
  return (
    (preferences.provider === "all" || item.forge === preferences.provider) &&
    preferences.states.includes(rules.state(item)) &&
    (!preferences.hideDrafts || !item.isDraft) &&
    (!preferences.needsAttention || rules.needsAttention(item)) &&
    matchesSearch(rules, item, query)
  );
}

const TAB_TITLES: Record<InboxTab, string> = { assigned: "Assigned to me", authored: "Authored by me" };

/** A tab's name with how many it lists, a `+` when a host listed only part of it, and no number until it is listed. */
export function tabLabel(tab: InboxTab, inbox: Inbox | undefined): string {
  if (inbox === undefined) return TAB_TITLES[tab];
  const partial = inbox.hosts.some((host) => host.truncated[tab]);
  return `${TAB_TITLES[tab]} · ${inbox[tab].length}${partial ? "+" : ""}`;
}

/** The inbox with the change request at `url` checked off or not on `tab`, leaving the same one on the other tab as it was. */
export function withCheckedOff(inbox: Inbox, tab: InboxTab, url: string, checkedOff: boolean): Inbox {
  return { ...inbox, [tab]: inbox[tab].map((item) => (item.url === url ? { ...item, checkedOff } : item)) };
}

/** Each reviewer state as a sentence names it mid-way. */
export const STATE_NAMES: Record<ReviewerState, string> = {
  requested: "requested",
  commented: "commented",
  "changes-requested": "changes requested",
  approved: "approved",
  unapproved: "approval reset",
};

/** Each review status of an authored change request as a sentence names it mid-way. */
export const STATUS_NAMES: Record<ReviewStatus, string> = {
  unreviewed: "unreviewed",
  waiting: "waiting",
  commented: "commented",
  "changes-requested": "changes requested",
  approved: "approved",
  "approval-reset": "approval reset",
};

/** Which states the list shows, naming whichever side is shorter: `States: requested and commented`, or `States: all but approved`. */
export function statesLabel(states: readonly ReviewerState[]): string {
  return shownLabel(states, ReviewerStateSchema.options, STATE_NAMES);
}

/** Which review statuses the Authored tab shows, named as `statesLabel` names states. */
export function statusesLabel(statuses: readonly ReviewStatus[]): string {
  return shownLabel(statuses, ReviewStatusSchema.options, STATUS_NAMES);
}

function shownLabel<State extends string>(shown: readonly State[], all: readonly State[], names: Record<State, string>): string {
  const hidden = all.filter((state) => !shown.includes(state));
  if (hidden.length === 0) return "States: all";
  const namesOf = (states: readonly State[]) => {
    const named = states.map((state) => names[state]);
    return named.length === 1 ? named[0] : `${named.slice(0, -1).join(", ")} and ${named.at(-1)}`;
  };
  if (shown.length <= hidden.length) return `States: ${namesOf(shown)}`;
  return `States: all but ${namesOf(hidden)}`;
}

/** How many rows the list shows, of how many when the filters or the search hide some, and how many of those are checked off. */
export function countLabel(shown: number, total: number, checkedOff = 0, [one, many] = ASSIGNED_RULES.noun): string {
  const noun = total === 1 ? one : many;
  const count = shown === total ? `${total} ${noun}` : `${shown} of ${total} ${noun}`;
  return checkedOff > 0 ? `${count} · ${checkedOff} checked off` : count;
}

/** How long ago `iso` was, in the largest whole unit: `5m`, `3h`, `2d`, `6w`, `1y`; `now` under a minute. */
export function age(iso: string, now: Date): string {
  const minutes = Math.floor((now.getTime() - Date.parse(iso)) / 60_000);
  if (!(minutes >= 1)) return "now";
  const units: [number, string][] = [
    [60 * 24 * 365, "y"],
    [60 * 24 * 7, "w"],
    [60 * 24, "d"],
    [60, "h"],
    [1, "m"],
  ];
  const [size, unit] = units.find(([size]) => minutes >= size) ?? [1, "m"];
  return `${Math.floor(minutes / size)}${unit}`;
}
