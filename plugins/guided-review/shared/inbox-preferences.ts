import { z } from "zod";
import { ReviewerStateSchema, ReviewStatusSchema } from "./inbox.ts";

/** The review list's tabs: the change requests the reviewer is asked to review, and those they authored. */
export const INBOX_TABS = ["assigned", "authored"] as const;
export type InboxTab = (typeof INBOX_TABS)[number];

/** Every column a tab can show, in the order it shows them; the title is what a row is, so it is always shown. */
export const ASSIGNED_COLUMNS = ["checked", "change", "title", "author", "updated", "created", "size", "ci", "state", "local"] as const;
export const AUTHORED_COLUMNS = ["checked", "change", "title", "reviewers", "updated", "created", "size", "ci", "state", "local"] as const;
export type AssignedColumn = (typeof ASSIGNED_COLUMNS)[number];
export type AuthoredColumn = (typeof AUTHORED_COLUMNS)[number];

/** Whether the list leaves out what the reviewer checked off, shows it among the rest, or shows nothing else. */
export const CHECK_OFF_FILTERS = ["hide", "show", "only"] as const;
export type CheckOffFilter = (typeof CHECK_OFF_FILTERS)[number];

export const INBOX_SORT_KEYS = ["updated", "created", "size"] as const;
export type InboxSortKey = (typeof INBOX_SORT_KEYS)[number];

/**
 * How the reviewer last left one tab of the review list.
 * Each field falls back to its default on its own, so a file written by an older or newer plugin keeps whatever of it still means something.
 */
function tabPreferencesSchema<State extends string, Column extends string>(tab: {
  states: readonly State[];
  defaultStates: readonly State[];
  columns: readonly Column[];
  defaultColumns: readonly Column[];
}) {
  const schema = z.object({
    provider: z.enum(["all", "github", "gitlab"]).catch("all"),
    /** The states the tab shows, never none, since a list filtered down to nothing is no use. */
    states: z
      .array(z.string())
      .transform((states) => tab.states.filter((state) => states.includes(state)))
      .refine((states) => states.length > 0)
      .catch([...tab.defaultStates]),
    hideDrafts: z.boolean().catch(false),
    checkedOff: z.enum(CHECK_OFF_FILTERS).catch("hide"),
    needsAttention: z.boolean().catch(false),
    sort: z.object({ key: z.enum(INBOX_SORT_KEYS), descending: z.boolean() }).catch({ key: "updated", descending: true }),
    columns: z
      .array(z.string())
      .transform((columns) => tab.columns.filter((column) => column === "title" || columns.includes(column)))
      .catch([...tab.defaultColumns]),
  });
  return schema.catch(() => schema.parse({}));
}

/** With nothing saved the Assigned tab leaves out what the reviewer approved. */
export const AssignedPreferencesSchema = tabPreferencesSchema({
  states: ReviewerStateSchema.options,
  defaultStates: ReviewerStateSchema.options.filter((state) => state !== "approved"),
  columns: ASSIGNED_COLUMNS,
  defaultColumns: ["checked", "change", "title", "author", "updated", "state", "local"],
});

/** With nothing saved the Authored tab leaves out what someone approved, and shows CI, which is the author's to fix. */
export const AuthoredPreferencesSchema = tabPreferencesSchema({
  states: ReviewStatusSchema.options,
  defaultStates: ReviewStatusSchema.options.filter((status) => status !== "approved"),
  columns: AUTHORED_COLUMNS,
  defaultColumns: ["checked", "change", "title", "reviewers", "updated", "ci", "state", "local"],
});

/** Both tabs' preferences, which travel together since the client saves them whole. */
export const InboxPreferencesSchema = z.object({ assigned: AssignedPreferencesSchema, authored: AuthoredPreferencesSchema });

export type AssignedPreferences = z.output<typeof AssignedPreferencesSchema>;
export type AuthoredPreferences = z.output<typeof AuthoredPreferencesSchema>;
export type InboxPreferences = z.output<typeof InboxPreferencesSchema>;

export const DEFAULT_INBOX_PREFERENCES: InboxPreferences = InboxPreferencesSchema.parse({});
