import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_INBOX_PREFERENCES, type AssignedPreferences } from "../shared/inbox-preferences.ts";
import { ReviewStatusSchema, type AuthoredInboxItem, type Inbox, type InboxItem } from "../shared/inbox.ts";
import {
  age,
  ASSIGNED_RULES,
  attentionCount,
  AUTHORED_RULES,
  countLabel,
  hiddenCheckedOff,
  matchesSearch,
  needsAttention,
  statesLabel,
  statusesLabel,
  tabLabel,
  visibleItems,
  withCheckedOff,
} from "./inbox-filter.ts";

function item(number: number, overrides: Partial<InboxItem> = {}): InboxItem {
  return {
    forge: "github",
    host: "github.com",
    project: "acme/uploader",
    number,
    url: `https://github.com/acme/uploader/pull/${number}`,
    title: "Retry failed uploads",
    author: "author",
    isDraft: false,
    createdAt: "2026-09-01T10:00:00Z",
    updatedAt: "2026-09-02T10:00:00Z",
    headSha: "b".repeat(40),
    additions: 10,
    deletions: 0,
    fileCount: 1,
    ci: null,
    state: "requested",
    viaTeam: null,
    changedSinceReview: null,
    pendingDrafts: 0,
    reviewId: null,
    local: null,
    checkedOff: false,
    ...overrides,
  };
}

const ALL: AssignedPreferences = { ...DEFAULT_INBOX_PREFERENCES.assigned, states: ["requested", "commented", "changes-requested", "approved", "unapproved"] };

function numbers(items: readonly { number: number }[]): number[] {
  return items.map((entry) => entry.number);
}

test("by default the newest update comes first and what the reviewer approved is hidden", () => {
  const items = [
    item(1, { updatedAt: "2026-09-01T00:00:00Z" }),
    item(2, { updatedAt: "2026-09-03T00:00:00Z", state: "approved" }),
    item(3, { updatedAt: "2026-09-02T00:00:00Z" }),
  ];

  assert.deepEqual(numbers(visibleItems(ASSIGNED_RULES, items, DEFAULT_INBOX_PREFERENCES.assigned, "")), [3, 1]);
  assert.deepEqual(numbers(visibleItems(ASSIGNED_RULES, items, ALL, "")), [2, 3, 1]);
});

test("filters by forge and drafts, and sorts by creation or size either way", () => {
  const items = [
    item(1, { forge: "gitlab", createdAt: "2026-08-01T00:00:00Z", additions: 5, deletions: 5 }),
    item(2, { isDraft: true, createdAt: "2026-08-03T00:00:00Z", additions: 100, deletions: 0 }),
    item(3, { createdAt: "2026-08-02T00:00:00Z", additions: 1, deletions: 1 }),
  ];

  assert.deepEqual(numbers(visibleItems(ASSIGNED_RULES, items, { ...ALL, provider: "gitlab" }, "")), [1]);
  assert.deepEqual(numbers(visibleItems(ASSIGNED_RULES, items, { ...ALL, hideDrafts: true, sort: { key: "created", descending: true } }, "")), [3, 1]);
  assert.deepEqual(numbers(visibleItems(ASSIGNED_RULES, items, { ...ALL, sort: { key: "size", descending: false } }, "")), [3, 1, 2]);
});

test("shows only the reviewer states chosen, updated since or not", () => {
  const items = [
    item(1),
    item(2, { state: "changes-requested", changedSinceReview: true }),
    item(3, { state: "commented", changedSinceReview: false }),
    item(4, { state: "requested", changedSinceReview: true }),
  ];

  assert.deepEqual(numbers(visibleItems(ASSIGNED_RULES, items, { ...ALL, states: ["requested"] }, "")), [1, 4]);
  assert.deepEqual(numbers(visibleItems(ASSIGNED_RULES, items, { ...ALL, states: ["commented", "changes-requested"] }, "")), [2, 3]);
});

test("checked-off items are hidden by default, shown among the rest, or shown alone", () => {
  const items = [item(1), item(2, { checkedOff: true }), item(3, { checkedOff: true, isDraft: true })];

  assert.deepEqual(numbers(visibleItems(ASSIGNED_RULES, items, ALL, "")), [1]);
  assert.deepEqual(numbers(visibleItems(ASSIGNED_RULES, items, { ...ALL, checkedOff: "show" }, "")), [1, 2, 3]);
  assert.deepEqual(numbers(visibleItems(ASSIGNED_RULES, items, { ...ALL, checkedOff: "only" }, "")), [2, 3]);
  assert.deepEqual(numbers(visibleItems(ASSIGNED_RULES, items, { ...ALL, checkedOff: "only", hideDrafts: true }, "")), [2], "with the other filters as well");
});

test("a held row stays whatever the check-off filter says, but not past the other filters", () => {
  const items = [item(1), item(2, { checkedOff: true }), item(3, { checkedOff: true, isDraft: true })];
  const held = new Set(items.map((entry) => entry.url));

  assert.deepEqual(numbers(visibleItems(ASSIGNED_RULES, items, ALL, "", held)), [1, 2, 3]);
  assert.deepEqual(numbers(visibleItems(ASSIGNED_RULES, items, { ...ALL, checkedOff: "only" }, "", held)), [1, 2, 3]);
  assert.deepEqual(numbers(visibleItems(ASSIGNED_RULES, items, { ...ALL, hideDrafts: true }, "", held)), [1, 2]);
});

test("the checked-off count is what the check-off filter alone hides", () => {
  const items = [item(1), item(2, { checkedOff: true }), item(3, { checkedOff: true, isDraft: true }), item(4, { checkedOff: true })];

  assert.equal(hiddenCheckedOff(ASSIGNED_RULES, items, ALL, ""), 3);
  assert.equal(hiddenCheckedOff(ASSIGNED_RULES, items, { ...ALL, hideDrafts: true }, ""), 2, "a draft the drafts filter hides anyway");
  assert.equal(hiddenCheckedOff(ASSIGNED_RULES, items, ALL, "", new Set([items[1]!.url])), 2, "a held row is shown");
  assert.equal(hiddenCheckedOff(ASSIGNED_RULES, items, { ...ALL, checkedOff: "show" }, ""), 0);
  assert.equal(hiddenCheckedOff(ASSIGNED_RULES, items, { ...ALL, checkedOff: "only" }, ""), 0);
});

test("the states label names whichever side is shorter", () => {
  assert.equal(statesLabel(ALL.states), "States: all");
  assert.equal(statesLabel(["requested"]), "States: requested");
  assert.equal(statesLabel(["requested", "commented"]), "States: requested and commented");
  assert.equal(statesLabel(["requested", "commented", "changes-requested", "unapproved"]), "States: all but approved");
  assert.equal(statesLabel(["requested", "commented", "changes-requested"]), "States: all but approved and approval reset");
});

test("Authored's states label names its review statuses the same way", () => {
  assert.equal(statusesLabel(AUTHORED_DEFAULTS.states), "States: all but approved");
  assert.equal(statusesLabel(["waiting", "approval-reset"]), "States: waiting and approval reset");
  assert.equal(statusesLabel([...ReviewStatusSchema.options]), "States: all");
});

test("needs attention is what was never reviewed, asked again, unapproved or changed since the review", () => {
  assert.equal(needsAttention(item(1)), true);
  assert.equal(needsAttention(item(1, { state: "unapproved" })), true);
  assert.equal(needsAttention(item(1, { state: "commented", changedSinceReview: true })), true);
  assert.equal(needsAttention(item(1, { state: "changes-requested", changedSinceReview: false })), false);
  assert.equal(needsAttention(item(1, { state: "approved", changedSinceReview: null })), false);
});

test("the attention count keeps what needs attention among what the default filters show, whatever the reviewer last set", () => {
  const items = [
    item(1, { state: "requested" }),
    item(2, { state: "unapproved" }),
    item(3, { state: "commented", changedSinceReview: true }),
    item(4, { state: "commented", changedSinceReview: false }),
    item(5, { state: "approved", changedSinceReview: true }),
    item(6, { state: "requested", checkedOff: true }),
    item(7, { forge: "gitlab", state: "requested", isDraft: true }),
  ];

  assert.equal(attentionCount(inboxOf(items)), 4);
  assert.equal(attentionCount(inboxOf([])), 0);
});

test("the search needs every word somewhere in the title, project, author or number as the forge writes it", () => {
  const mr = item(12, { forge: "gitlab", project: "example-group/service", title: "Add rate limiting", author: "kobe" });

  for (const query of ["", "rate", "RATE limit", "service !12", "kobe", "  limiting  "]) assert.equal(matchesSearch(ASSIGNED_RULES, mr, query), true, query);
  for (const query of ["#12", "rate github", "uploader"]) assert.equal(matchesSearch(ASSIGNED_RULES, mr, query), false, query);
});

function mine(number: number, overrides: Partial<AuthoredInboxItem> = {}): AuthoredInboxItem {
  const { state: _, viaTeam: __, changedSinceReview: ___, ...listed } = item(number, { author: "me" });
  return { ...listed, status: "waiting", reviewers: [], reviewedSinceLastPush: false, latestReviewAt: null, ...overrides };
}

const AUTHORED_DEFAULTS = DEFAULT_INBOX_PREFERENCES.authored;

test("Authored lists newest first by default, drafts in their place, and filters by forge and drafts and sorts by its own preferences", () => {
  const items = [
    mine(1, { updatedAt: "2026-09-01T00:00:00Z", forge: "gitlab", additions: 1 }),
    mine(2, { updatedAt: "2026-09-03T00:00:00Z", isDraft: true, additions: 50 }),
    mine(3, { updatedAt: "2026-09-02T00:00:00Z", additions: 5 }),
  ];

  assert.deepEqual(numbers(visibleItems(AUTHORED_RULES, items, AUTHORED_DEFAULTS, "")), [2, 3, 1]);
  assert.deepEqual(numbers(visibleItems(AUTHORED_RULES, items, { ...AUTHORED_DEFAULTS, provider: "github" }, "")), [2, 3]);
  assert.deepEqual(numbers(visibleItems(AUTHORED_RULES, items, { ...AUTHORED_DEFAULTS, hideDrafts: true }, "")), [3, 1]);
  assert.deepEqual(numbers(visibleItems(AUTHORED_RULES, items, { ...AUTHORED_DEFAULTS, sort: { key: "size", descending: false } }, "")), [1, 3, 2]);
});

test("Authored filters by review status, by default everything but what is approved", () => {
  const items = [
    mine(1, { status: "unreviewed" }),
    mine(2, { status: "waiting" }),
    mine(3, { status: "commented" }),
    mine(4, { status: "changes-requested" }),
    mine(5, { status: "approved" }),
    mine(6, { status: "approval-reset" }),
  ];

  assert.deepEqual(numbers(visibleItems(AUTHORED_RULES, items, { ...AUTHORED_DEFAULTS, sort: { key: "created", descending: false } }, "")), [1, 2, 3, 4, 6]);
  assert.deepEqual(numbers(visibleItems(AUTHORED_RULES, items, { ...AUTHORED_DEFAULTS, states: ["approved", "approval-reset"] }, "")), [5, 6]);
});

test("an authored change request needs attention on a change request, a review since the last push, or failing CI, and not on an approval reset", () => {
  const items = [
    mine(1, { status: "changes-requested" }),
    mine(2, { status: "commented", reviewedSinceLastPush: true }),
    mine(3, { status: "waiting", ci: "failure" }),
    mine(4, { status: "approval-reset" }),
    mine(5, { status: "commented", reviewedSinceLastPush: null, ci: "pending" }),
    mine(6, { status: "approved", reviewedSinceLastPush: false, ci: "success" }),
  ];
  const attention = { ...AUTHORED_DEFAULTS, states: [...ReviewStatusSchema.options], needsAttention: true, sort: { key: "created" as const, descending: false } };

  assert.deepEqual(numbers(visibleItems(AUTHORED_RULES, items, attention, "")), [1, 2, 3]);
});

test("Authored hides its checked-off change requests by default, shows them among the rest, or shows them alone", () => {
  const items = [mine(1), mine(2, { checkedOff: true }), mine(3, { checkedOff: true, isDraft: true })];
  const any = { ...AUTHORED_DEFAULTS, sort: { key: "created" as const, descending: false } };

  assert.deepEqual(numbers(visibleItems(AUTHORED_RULES, items, any, "")), [1]);
  assert.deepEqual(numbers(visibleItems(AUTHORED_RULES, items, { ...any, checkedOff: "show" }, "")), [1, 2, 3]);
  assert.deepEqual(numbers(visibleItems(AUTHORED_RULES, items, { ...any, checkedOff: "only" }, "")), [2, 3]);
  assert.deepEqual(numbers(visibleItems(AUTHORED_RULES, items, { ...any, checkedOff: "only" }, "", new Set([mine(1).url]))), [1, 2, 3], "a held row stays");
  assert.equal(hiddenCheckedOff(AUTHORED_RULES, items, any, ""), 2);
});

test("checking a change request off marks it on that tab only, though the same one is on the other", () => {
  const url = "https://gitlab.com/acme/uploader/-/merge_requests/7";
  const both = inboxOf([item(7, { url }), item(8)], [mine(7, { url })]);

  const assigned = withCheckedOff(both, "assigned", url, true);
  assert.deepEqual([assigned.assigned.map((entry) => entry.checkedOff), assigned.authored.map((entry) => entry.checkedOff)], [[true, false], [false]]);
  const authored = withCheckedOff(assigned, "authored", url, true);
  assert.deepEqual([authored.assigned.map((entry) => entry.checkedOff), authored.authored.map((entry) => entry.checkedOff)], [[true, false], [true]]);
  const unchecked = withCheckedOff(authored, "assigned", url, false);
  assert.deepEqual([unchecked.assigned.map((entry) => entry.checkedOff), unchecked.authored.map((entry) => entry.checkedOff)], [[false, false], [true]]);
});

test("the search on Authored needs every word in the title, project, reviewers or number, not the viewer's own name", () => {
  const mr = mine(12, {
    forge: "gitlab",
    project: "example-group/service",
    title: "Add rate limiting",
    reviewers: [
      { name: "kobe", state: "approved" },
      { name: "example-org/backend", state: "requested" },
    ],
  });

  for (const query of ["", "rate", "service !12", "LIMITING", "kobe", "backend rate"]) assert.equal(matchesSearch(AUTHORED_RULES, mr, query), true, query);
  for (const query of ["me", "#12", "uploader"]) assert.equal(matchesSearch(AUTHORED_RULES, mr, query), false, query);
});

function inboxOf(assigned: InboxItem[], authored: AuthoredInboxItem[] = [], hosts: Inbox["hosts"] = []): Inbox {
  return { hosts, assigned, authored };
}

function host(name: string, truncated: Partial<Record<"assigned" | "authored", boolean>> = {}): Inbox["hosts"][number] {
  return { forge: "github", host: name, truncated: { assigned: false, authored: false, ...truncated }, error: null };
}

test("a tab's label gives its listed total, with a + when a host listed only part of it, and no number until it is listed", () => {
  const inbox = inboxOf([item(1), item(2, { checkedOff: true })], [mine(3)], [host("github.com", { authored: true }), host("gitlab.com")]);

  assert.equal(tabLabel("assigned", undefined), "Assigned to me");
  assert.equal(tabLabel("authored", undefined), "Authored by me");
  assert.equal(tabLabel("assigned", inbox), "Assigned to me · 2");
  assert.equal(tabLabel("authored", inbox), "Authored by me · 1+");
  assert.equal(tabLabel("authored", inboxOf([], [])), "Authored by me · 0");
});

test("the sidebar's attention count leaves the viewer's own change requests out", () => {
  const authored = [mine(1, { ci: "failure" }), mine(2)];

  assert.equal(attentionCount(inboxOf([item(3)], authored)), 1);
  assert.equal(attentionCount(inboxOf([], authored)), 0);
});

test("Authored counts change requests rather than reviews", () => {
  assert.equal(countLabel(1, 1, 0, AUTHORED_RULES.noun), "1 change request");
  assert.equal(countLabel(2, 5, 0, AUTHORED_RULES.noun), "2 of 5 change requests");
});

test("an age is the largest whole unit", () => {
  const now = new Date("2026-10-05T12:00:00Z");

  assert.equal(age("2026-10-05T11:59:30Z", now), "now");
  assert.equal(age("2026-10-05T11:55:00Z", now), "5m");
  assert.equal(age("2026-10-05T09:00:00Z", now), "3h");
  assert.equal(age("2026-10-03T12:00:00Z", now), "2d");
  assert.equal(age("2026-08-20T12:00:00Z", now), "6w");
  assert.equal(age("2025-09-01T12:00:00Z", now), "1y");
  assert.equal(age("2026-10-06T12:00:00Z", now), "now");
});

test("countLabel gives the total alone until something is hidden", () => {
  assert.equal(countLabel(12, 12), "12 reviews");
  assert.equal(countLabel(1, 1), "1 review");
  assert.equal(countLabel(4, 12), "4 of 12 reviews");
  assert.equal(countLabel(1, 12), "1 of 12 reviews");
  assert.equal(countLabel(8, 12, 3), "8 of 12 reviews · 3 checked off");
});
