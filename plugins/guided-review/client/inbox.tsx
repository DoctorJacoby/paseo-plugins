import { useRpc } from "@getpaseo/plugin/client";
import { Modal, TextInput } from "@getpaseo/plugin/client/react-native";
import { ExternalLink, SettingsAction, SettingsCard, SettingsSection, SettingsSwitch } from "@getpaseo/plugin/client/ui";
import { useQuery, type UseQueryResult } from "@tanstack/react-query";
import React, { useContext, useState } from "react";
import { Pressable, Text, View } from "react-native";
import * as contracts from "../shared/contracts.ts";
import {
  ASSIGNED_COLUMNS,
  AUTHORED_COLUMNS,
  CHECK_OFF_FILTERS,
  INBOX_TABS,
  type AssignedColumn,
  type AuthoredColumn,
  type CheckOffFilter,
  type InboxSortKey,
  type InboxTab,
} from "../shared/inbox-preferences.ts";
import {
  headMoved,
  ReviewerStateSchema,
  ReviewStatusSchema,
  type AuthoredInboxItem,
  type Inbox,
  type InboxItem,
  type LocalReview,
  type ReviewerState,
  type ReviewStatus,
} from "../shared/inbox.ts";
import { numberLabel } from "../shared/reference.ts";
import { Button } from "./button.tsx";
import { ASSIGNED_CHECK_OFF, AUTHORED_CHECK_OFF, CheckOffContext, INBOX_QUERY_KEY, useCheckOff, type CheckOffControl } from "./check-off.ts";
import {
  age,
  ASSIGNED_RULES,
  AUTHORED_RULES,
  countLabel,
  hiddenCheckedOff,
  passesCheckOff,
  STATE_NAMES,
  STATUS_NAMES,
  statesLabel,
  statusesLabel,
  tabLabel,
  visibleItems,
  type ListedItem,
  type ListFilters,
  type TabRules,
} from "./inbox-filter.ts";
import { useInboxPreferences, type InboxPreferencesControl } from "./inbox-preferences.ts";
import { NewReview } from "./new-review.tsx";
import { describePreparing, describeProgress } from "./start-progress.ts";
import { useReviewStarts, type Pasted, type ReviewStarts } from "./start-review.ts";
import { fontSize, leading, radius, spacing, type Colors } from "./theme.ts";
import { onVisibleWidth } from "./visible-width.ts";

const FORGE_NAMES = { github: "GitHub", gitlab: "GitLab" } as const;

const CHECK_OFF_LABELS: Record<CheckOffFilter, string> = { hide: "Hide checked off", show: "With checked off", only: "Checked off only" };

/** A row of either tab, with the review started here if any. */
type Row = ListedItem & { reviewId: string | null; local: LocalReview | null };

/** One tab's filters, sort and columns. */
type TabPreferences<State extends string, Column extends string> = ListFilters<State> & { columns: Column[] };

/** The States chooser of a tab that has states to filter by. */
type StatesSetup<State extends string> = {
  all: readonly State[];
  label(states: readonly State[]): string;
  name(state: State): string;
  hint(state: State): string | undefined;
};

/** What a tab shows and offers, beside how its filters read a row. */
type TabView<Item extends Row, State extends string, Column extends string> = {
  tab: InboxTab;
  rules: TabRules<Item, State>;
  /** Every column the tab can have, in the order it shows them. */
  columns: readonly Column[];
  specs: Record<Column, ColumnSpec<Item>>;
  /** The columns a card puts on its tinted line, in the order it puts them. */
  tinted: readonly Column[];
  states: StatesSetup<State>;
  searchHint: string;
  listing: string;
  failure: string;
  empty: string;
};

/** The change requests the viewer reviews and the ones they authored, as two tabs, to pick one and start or continue its review. */
export function ReviewInbox({ colors, compact, openPanel }: { colors: Colors; compact: boolean; openPanel: (workspaceId: string) => void }) {
  const getInbox = useRpc(contracts.getInbox);
  const inbox = useQuery({ queryKey: INBOX_QUERY_KEY, queryFn: () => getInbox({}), refetchOnWindowFocus: false });
  const starts = useReviewStarts(openPanel, [...(inbox.data?.assigned ?? []), ...(inbox.data?.authored ?? [])]);
  const assigned = useInboxPreferences("assigned");
  const authored = useInboxPreferences("authored");
  const checkOffs = { assigned: useCheckOff(ASSIGNED_CHECK_OFF), authored: useCheckOff(AUTHORED_CHECK_OFF) };
  const [tab, setTab] = useState<InboxTab>("assigned");
  const [queries, setQueries] = useState<Record<InboxTab, string>>({ assigned: "", authored: "" });
  const [width, setWidth] = useState<number | null>(null);

  const setQuery = (next: string) => {
    checkOffs[tab].release();
    setQueries((current) => ({ ...current, [tab]: next }));
  };
  const refresh = () => {
    checkOffs.assigned.release();
    checkOffs.authored.release();
    starts.forget();
    void inbox.refetch();
  };
  const shared = {
    colors,
    compact,
    width,
    inbox,
    starts,
    refresh,
    query: queries[tab],
    setQuery,
    tabs: <TabSwitch colors={colors} tab={tab} setTab={setTab} inbox={inbox.data} />,
  };

  return (
    <View onLayout={onVisibleWidth(setWidth)}>
      {tab === "assigned" ? (
        <TabSection key={tab} {...shared} view={ASSIGNED_VIEW} listed={inbox.data?.assigned} preferences={assigned} checkOff={checkOffs.assigned} />
      ) : (
        <TabSection key={tab} {...shared} view={AUTHORED_VIEW} listed={inbox.data?.authored} preferences={authored} checkOff={checkOffs.authored} />
      )}
    </View>
  );
}

/** The two tabs as one switch, each with how many it lists. */
function TabSwitch({ colors, tab, setTab, inbox }: { colors: Colors; tab: InboxTab; setTab: (tab: InboxTab) => void; inbox: Inbox | undefined }) {
  return (
    <View
      accessibilityRole="tablist"
      style={{ flexDirection: "row", alignSelf: "flex-start", borderWidth: 1, borderColor: colors.border, borderRadius: radius.md, overflow: "hidden" }}
    >
      {INBOX_TABS.map((candidate) => {
        const selected = candidate === tab;
        return (
          <Pressable
            key={candidate}
            onPress={() => setTab(candidate)}
            accessibilityRole="tab"
            accessibilityState={{ selected }}
            style={({ pressed }) => ({
              paddingVertical: spacing[1],
              paddingHorizontal: spacing[3],
              backgroundColor: selected ? colors.accent : undefined,
              opacity: pressed ? 0.85 : 1,
            })}
          >
            <Text
              style={{
                color: selected ? colors.accentForeground : colors.foreground,
                fontSize: fontSize.sm,
                lineHeight: leading(fontSize.sm),
                fontVariant: ["tabular-nums"],
              }}
            >
              {tabLabel(candidate, inbox)}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

/** The section as one tab shows it. */
function TabSection<Item extends Row, State extends string, Column extends string>({
  colors,
  compact,
  width,
  inbox,
  starts,
  refresh,
  query,
  setQuery,
  tabs,
  view,
  listed = [],
  preferences: control,
  checkOff,
}: {
  colors: Colors;
  compact: boolean;
  width: number | null;
  inbox: UseQueryResult<Inbox>;
  starts: ReviewStarts;
  refresh: () => void;
  query: string;
  setQuery: (query: string) => void;
  tabs: React.ReactNode;
  view: TabView<Item, State, Column>;
  listed: readonly Item[] | undefined;
  preferences: InboxPreferencesControl<TabPreferences<State, Column>>;
  checkOff: CheckOffControl<Item>;
}) {
  const { preferences, error } = control;
  const [choosing, setChoosing] = useState<"columns" | "states" | null>(null);
  const { held } = checkOff;

  const change = (update: Partial<TabPreferences<State, Column>>) => {
    checkOff.release();
    control.change(update);
  };
  const items = visibleItems(view.rules, listed, preferences, query, held).map((item) => ({ ...item, local: starts.local(item.reviewId, item.local) }));
  // Until the list has been measured it is not drawn, rather than as cards for a frame.
  const shape = compact ? "cards" : width === null ? null : width >= tableWidth(view.specs, preferences.columns) ? "table" : "cards";
  const rows = {
    toggle: (row: ListedItem) => {
      const item = listed.find((entry) => entry.url === row.url);
      if (item !== undefined) checkOff.toggle(item);
    },
    dimmed: (item: ListedItem) => held.has(item.url) && !passesCheckOff(item, preferences),
  };

  return (
    <>
      <SettingsSection
        title="Change requests"
        trailing={
          <View style={{ flexDirection: "row", gap: spacing[2] }}>
            <NewReview colors={colors} starts={starts} />
            <Button colors={colors} small label="Columns" onPress={() => setChoosing("columns")} />
            <Button colors={colors} small label={view.states.label(preferences.states)} onPress={() => setChoosing("states")} />
            <Button colors={colors} small label={inbox.isFetching ? "Refreshing…" : "Refresh"} disabled={inbox.isFetching || checkOff.saving} onPress={refresh} />
          </View>
        }
      >
        <View style={{ gap: spacing[3] }}>
          {tabs}
          <Toolbar
            colors={colors}
            preferences={preferences}
            change={change}
            query={query}
            setQuery={setQuery}
            searchHint={view.searchHint}
          />
          {error !== null ? <Note colors={colors} tone="danger" text={`Could not keep these filters for next time: ${error}`} /> : null}
          {checkOff.error !== null ? <Note colors={colors} tone="danger" text={`Could not keep that check-off: ${checkOff.error}`} /> : null}
          {inbox.data ? <HostNotes colors={colors} hosts={inbox.data.hosts} tab={view.tab} /> : null}
          <PastedRows colors={colors} starts={starts} shown={items} />
          {inbox.isPending ? (
            <Note colors={colors} text={view.listing} />
          ) : inbox.isError ? (
            <Note colors={colors} tone="danger" text={`${view.failure}: ${inbox.error.message}`} />
          ) : items.length === 0 ? (
            <Note colors={colors} text={listed.length === 0 ? view.empty : "Nothing matches these filters."} />
          ) : (
            <CheckOffContext.Provider value={rows}>
              <View style={{ gap: spacing[2] }}>
                <Note colors={colors} text={countLabel(items.length, listed.length, hiddenCheckedOff(view.rules, listed, preferences, query, held), view.rules.noun)} />
                {shape === "table" ? (
                  <Table colors={colors} items={items} specs={view.specs} columns={preferences.columns} preferences={preferences} change={change} starts={starts} />
                ) : shape === "cards" ? (
                  <View style={{ gap: spacing[2] }}>
                    {items.map((item) => (
                      <Card key={item.url} colors={colors} item={item} specs={view.specs} columns={preferences.columns} tinted={view.tinted} starts={starts} />
                    ))}
                  </View>
                ) : null}
              </View>
            </CheckOffContext.Provider>
          )}
        </View>
      </SettingsSection>
      <ColumnChooser
        open={choosing === "columns"}
        onOpenChange={(open) => setChoosing(open ? "columns" : null)}
        all={view.columns}
        specs={view.specs}
        columns={preferences.columns}
        change={change}
      />
      <StateChooser open={choosing === "states"} onOpenChange={(open) => setChoosing(open ? "states" : null)} setup={view.states} states={preferences.states} change={change} />
    </>
  );
}

/** Which columns the table shows; the title is what a row is, so it always is. */
function ColumnChooser<Item extends Row, Column extends string>({
  open,
  onOpenChange,
  all,
  specs,
  columns,
  change,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  all: readonly Column[];
  specs: Record<Column, ColumnSpec<Item>>;
  columns: readonly Column[];
  change: (update: { columns: Column[] }) => void;
}) {
  const toggle = (column: Column, shown: boolean) => change({ columns: all.filter((candidate) => (candidate === column ? shown : columns.includes(candidate))) });
  return (
    <Modal title="Columns" open={open} onOpenChange={onOpenChange}>
      <Modal.Content>
        <SettingsCard>
          {all.map((column) => {
            const { label, hint } = specs[column];
            return (
              <SettingsSwitch
                key={column}
                label={label}
                {...(hint === undefined ? {} : { hint })}
                value={column === "title" || columns.includes(column)}
                disabled={column === "title"}
                onValueChange={(shown) => toggle(column, shown)}
              />
            );
          })}
        </SettingsCard>
      </Modal.Content>
    </Modal>
  );
}

/** Which states the list shows; the last one shown stays on, as a list showing none is no use. */
function StateChooser<State extends string>({
  open,
  onOpenChange,
  setup,
  states,
  change,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  setup: StatesSetup<State>;
  states: readonly State[];
  change: (update: { states: State[] }) => void;
}) {
  const { all } = setup;
  const toggle = (state: State, shown: boolean) => change({ states: all.filter((candidate) => (candidate === state ? shown : states.includes(candidate))) });
  return (
    <Modal title="States" open={open} onOpenChange={onOpenChange}>
      <Modal.Content>
        <SettingsCard>
          <SettingsAction label="All" actionLabel="Show all" disabled={states.length === all.length} onPress={() => change({ states: [...all] })} />
          {all.map((state) => {
            const hint = setup.hint(state);
            return (
              <SettingsSwitch
                key={state}
                label={setup.name(state)}
                {...(hint === undefined ? {} : { hint })}
                value={states.includes(state)}
                disabled={states.length === 1 && states.includes(state)}
                onValueChange={(shown) => toggle(state, shown)}
              />
            );
          })}
        </SettingsCard>
      </Modal.Content>
    </Modal>
  );
}

function Toolbar<State extends string>({
  colors,
  preferences,
  change,
  query,
  setQuery,
  searchHint,
}: {
  colors: Colors;
  preferences: ListFilters<State>;
  change: (update: Partial<ListFilters<State>>) => void;
  query: string;
  setQuery: (query: string) => void;
  searchHint: string;
}) {
  return (
    <View style={{ gap: spacing[2] }}>
      <TextInput
        value={query}
        onChangeText={setQuery}
        placeholder={searchHint}
        placeholderTextColor={colors.foregroundMuted}
        autoCorrect={false}
        autoCapitalize="none"
        style={{
          color: colors.foreground,
          fontSize: fontSize.base,
          lineHeight: leading(fontSize.base),
          paddingVertical: spacing[1],
          paddingHorizontal: spacing[3],
          borderWidth: 1,
          borderColor: colors.border,
          borderRadius: radius.md,
          backgroundColor: colors.surface1,
        }}
      />
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: spacing[2], alignItems: "center" }}>
        {(["all", "github", "gitlab"] as const).map((provider) => (
          <Chip
            key={provider}
            colors={colors}
            label={provider === "all" ? "All" : FORGE_NAMES[provider]}
            selected={preferences.provider === provider}
            onPress={() => change({ provider })}
          />
        ))}
        <Divider colors={colors} />
        <Chip colors={colors} label="Needs my attention" selected={preferences.needsAttention} onPress={() => change({ needsAttention: !preferences.needsAttention })} />
        <Chip colors={colors} label="Hide drafts" selected={preferences.hideDrafts} onPress={() => change({ hideDrafts: !preferences.hideDrafts })} />
        <Divider colors={colors} />
        {CHECK_OFF_FILTERS.map((checkedOff) => (
          <Chip
            key={checkedOff}
            colors={colors}
            label={CHECK_OFF_LABELS[checkedOff]}
            selected={preferences.checkedOff === checkedOff}
            onPress={() => change({ checkedOff })}
          />
        ))}
      </View>
    </View>
  );
}

function Divider({ colors }: { colors: Colors }) {
  return <View style={{ width: 1, alignSelf: "stretch", backgroundColor: colors.border, marginHorizontal: spacing[1] }} />;
}

function Chip({ colors, label, selected, onPress }: { colors: Colors; label: string; selected: boolean; onPress: () => void }) {
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityState={{ selected }}
      style={({ pressed }) => ({
        paddingVertical: 2,
        paddingHorizontal: spacing[3],
        borderRadius: radius.full,
        borderWidth: 1,
        borderColor: selected ? colors.accent : colors.border,
        backgroundColor: selected ? colors.accent : undefined,
        opacity: pressed ? 0.85 : 1,
      })}
    >
      <Text style={{ color: selected ? colors.accentForeground : colors.foreground, fontSize: fontSize.sm, lineHeight: leading(fontSize.sm) }}>{label}</Text>
    </Pressable>
  );
}

function Note({ colors, text, tone }: { colors: Colors; text: string; tone?: "danger" }) {
  return (
    <Text style={{ color: tone === "danger" ? colors.statusDanger : colors.foregroundMuted, fontSize: fontSize.sm, lineHeight: leading(fontSize.sm) }}>
      {text}
    </Text>
  );
}

/** A host that could not be listed says so on both tabs, and one with more than a page says so on the tab it cut short; the rest list as usual. */
function HostNotes({ colors, hosts, tab }: { colors: Colors; hosts: Inbox["hosts"]; tab: InboxTab }) {
  const notes = hosts.flatMap((host): { key: string; tone?: "danger"; text: string }[] => {
    if (host.error !== null) return [{ key: host.host, tone: "danger", text: `${host.host}: ${host.error}` }];
    if (host.truncated[tab]) return [{ key: host.host, text: `${host.host} has more than this lists; only the first page is shown.` }];
    return [];
  });
  if (notes.length === 0) return null;
  return (
    <View style={{ gap: spacing[1] }}>
      {notes.map((note) => (
        <Note key={note.key} colors={colors} tone={note.tone} text={note.text} />
      ))}
    </View>
  );
}

type Tinted = { text: string; color: keyof Colors };

function capitalised(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** Where the reviewer stands, with whether it moved on since their review. */
function stateOf(item: InboxItem): Tinted {
  const since = item.changedSinceReview === true;
  switch (item.state) {
    case "requested":
      if (item.viaTeam !== null) return { text: `Requested via ${item.viaTeam}`, color: "foreground" };
      return { text: since ? "Requested again" : "Requested", color: "foreground" };
    case "commented":
      return { text: since ? "Commented · updated since" : "Commented", color: since ? "statusWarning" : "foregroundMuted" };
    case "changes-requested":
      return { text: since ? "Changes requested · updated since" : "Changes requested", color: since ? "statusWarning" : "foregroundMuted" };
    case "approved":
      return { text: since ? "Approved · updated since" : "Approved", color: since ? "statusWarning" : "statusSuccess" };
    case "unapproved":
      return { text: "Approval reset", color: "statusWarning" };
  }
}

const STATUS_TINTS: Record<ReviewStatus, keyof Colors> = {
  unreviewed: "foregroundMuted",
  waiting: "foreground",
  commented: "foregroundMuted",
  "changes-requested": "statusDanger",
  approved: "statusSuccess",
  "approval-reset": "statusWarning",
};

const STATUS_HINTS: Record<ReviewStatus, string> = {
  unreviewed: "Nobody is asked and nobody reviewed",
  waiting: "Reviewers are asked and none reviewed yet",
  commented: "Reviews without an approval or a change request",
  "changes-requested": "A reviewer's latest review asks for changes",
  approved: "Approved, with no change request outstanding",
  "approval-reset": "An approval taken back by a push, or on GitLab by its reviewer",
};

/** Where the author's reviewers stand, with whether one reviewed since their last push. */
function statusOf(item: AuthoredInboxItem): Tinted {
  const text = capitalised(STATUS_NAMES[item.status]);
  if (item.reviewedSinceLastPush === true) return { text: `${text} · reviewed since your last push`, color: "statusWarning" };
  return { text, color: STATUS_TINTS[item.status] };
}

const REVIEWER_TINTS: Record<ReviewerState, keyof Colors> = {
  requested: "foreground",
  commented: "foregroundMuted",
  "changes-requested": "statusDanger",
  approved: "statusSuccess",
  unapproved: "statusWarning",
};

function reviewersOf(item: AuthoredInboxItem): Tinted[] {
  return item.reviewers.map((reviewer) => ({ text: reviewer.name, color: REVIEWER_TINTS[reviewer.state] }));
}

/** Each reviewer in their own tint, as many as fit on two lines. */
function ReviewersCell({ colors, reviewers }: { colors: Colors; reviewers: Tinted[] }) {
  if (reviewers.length === 0) return <Cell colors={colors} text="—" color="foregroundMuted" />;
  return (
    <Text numberOfLines={2} style={{ color: colors.foregroundMuted, fontSize: fontSize.sm, lineHeight: leading(fontSize.sm) }}>
      {reviewers.map((reviewer, index) => (
        <React.Fragment key={reviewer.text}>
          {index > 0 ? ", " : ""}
          <Text style={{ color: colors[reviewer.color] }}>{reviewer.text}</Text>
        </React.Fragment>
      ))}
    </Text>
  );
}

const GUIDE_STATES: Record<LocalReview["guide"], string> = {
  none: "Started",
  "choosing-scope": "Choose what to guide",
  generating: "Guide generating",
  ready: "Guide ready",
  failed: "Guide failed",
};

/** What this plugin has of the review, and the viewer's pending drafts wherever they were written. */
function localOf(item: Row): Tinted | null {
  const drafts = item.pendingDrafts ? [`${item.pendingDrafts} draft${item.pendingDrafts === 1 ? "" : "s"}`] : [];
  const { local } = item;
  if (local === null) return drafts.length > 0 ? { text: drafts.join(" · "), color: "foregroundMuted" } : null;
  const failed = local.preparing?.phase === "failed";
  const state =
    local.preparing === null ? GUIDE_STATES[local.guide] : failed ? "Start failed" : "Preparing";
  const moved = headMoved(item, local);
  const parts = [state, ...(moved ? ["head moved"] : []), ...drafts];
  const color = failed || (local.preparing === null && local.guide === "failed") ? "statusDanger" : moved ? "statusWarning" : "foregroundMuted";
  return { text: parts.join(" · "), color };
}

function ciOf(item: Row): Tinted | null {
  switch (item.ci) {
    case "success":
      return { text: "Passed", color: "statusSuccess" };
    case "failure":
      return { text: "Failed", color: "statusDanger" };
    case "pending":
      return { text: "Running", color: "statusWarning" };
    case null:
      return null;
  }
}

function linesOf(item: Row): string {
  return `+${item.additions} −${item.deletions}`;
}

function filesOf(item: Row): string {
  return `${item.fileCount} file${item.fileCount === 1 ? "" : "s"}`;
}

/** A column's width: fixed for a value whose length is known, else a share of what is left, never under `min`. */
type ColumnWidth = { width: number } | { flex: number; min: number };

/**
 * `label` names the column in the chooser, and heads it unless `header` says otherwise.
 * A card puts the `besideTitle` column before the title, every `line` on the line under it, and every `tint` on the tinted line below that, in the tab's `tinted` order.
 */
type ColumnSpec<Item> = {
  label: string;
  header?: string;
  hint?: string;
  size: ColumnWidth;
  sort?: InboxSortKey;
  cell: (item: Item, colors: Colors, now: Date) => React.ReactNode;
  line?: (item: Item, now: Date) => string;
  tint?: (item: Item) => Tinted | Tinted[] | null;
  besideTitle?: true;
};

function tintedColumn<Item>(spec: Omit<ColumnSpec<Item>, "cell" | "tint">, tint: (item: Item) => Tinted | null): ColumnSpec<Item> {
  return { ...spec, tint, cell: (item, colors) => <TintedCell colors={colors} value={tint(item)} /> };
}

function textColumn<Item>(spec: Omit<ColumnSpec<Item>, "cell" | "line">, text: (item: Item, now: Date) => string, line: (item: Item, now: Date) => string): ColumnSpec<Item> {
  return { ...spec, line, cell: (item, colors, now) => <Cell colors={colors} text={text(item, now)} color="foregroundMuted" /> };
}

/** The columns both tabs fill the same way. */
const ROW_COLUMNS = {
  change: {
    label: "PR/MR",
    size: { flex: 1.2, min: 96 },
    line: (item: Row) => item.project,
    cell: (item: Row, colors: Colors) => (
      <View>
        <NumberLink colors={colors} item={item} />
        <Cell colors={colors} text={item.project} color="foregroundMuted" />
      </View>
    ),
  },
  title: { label: "Title", hint: "Always shown", size: { flex: 3, min: 160 }, cell: (item: Row, colors: Colors) => <Title colors={colors} item={item} /> },
  updated: textColumn<Row>(
    { label: "Updated", size: { width: 72 }, sort: "updated" },
    (item, now) => age(item.updatedAt, now),
    (item, now) => `updated ${age(item.updatedAt, now)} ago`,
  ),
  created: textColumn<Row>(
    { label: "Created", size: { width: 72 }, sort: "created" },
    (item, now) => age(item.createdAt, now),
    (item, now) => `opened ${age(item.createdAt, now)} ago`,
  ),
  size: {
    label: "Size",
    size: { width: 80 },
    sort: "size",
    line: (item: Row) => `${linesOf(item)} in ${filesOf(item)}`,
    cell: (item: Row, colors: Colors) => (
      <View>
        <Cell colors={colors} text={linesOf(item)} color="foregroundMuted" />
        <Cell colors={colors} text={filesOf(item)} color="foregroundMuted" />
      </View>
    ),
  },
  ci: tintedColumn<Row>({ label: "CI", hint: "Whether the head's pipeline or checks passed", size: { width: 64 } }, ciOf),
  local: tintedColumn<Row>({ label: "Here", hint: "The guide and drafts you have for it in this plugin", size: { flex: 1.4, min: 96 } }, localOf),
} satisfies Record<string, ColumnSpec<Row>>;

function checkedColumn(hint: string): ColumnSpec<Row> {
  return { label: "Checked off", header: "", hint, size: { width: 20 }, besideTitle: true, cell: (item, colors) => <CheckOffBox colors={colors} item={item} /> };
}

const ASSIGNED_SPECS: Record<AssignedColumn, ColumnSpec<InboxItem>> = {
  ...ROW_COLUMNS,
  checked: checkedColumn("Set a review aside here until it is pushed to or you are asked again"),
  author: textColumn<InboxItem>({ label: "Author", size: { flex: 1, min: 64 } }, (item) => item.author, (item) => item.author),
  state: tintedColumn<InboxItem>({ label: "My review", hint: "Where you stand, and whether it changed since your review", size: { flex: 1.4, min: 96 } }, stateOf),
};

const AUTHORED_SPECS: Record<AuthoredColumn, ColumnSpec<AuthoredInboxItem>> = {
  ...ROW_COLUMNS,
  checked: checkedColumn("Set it aside here until a reviewer reviews again or its review status changes"),
  reviewers: {
    label: "Reviewers",
    hint: "Who is asked or reviewed, tinted by where each stands",
    size: { flex: 1.4, min: 96 },
    tint: reviewersOf,
    cell: (item, colors) => <ReviewersCell colors={colors} reviewers={reviewersOf(item)} />,
  },
  state: tintedColumn<AuthoredInboxItem>({ label: "State", hint: "Where your reviewers stand, and whether one reviewed since your last push", size: { flex: 1.4, min: 96 } }, statusOf),
};

const ASSIGNED_VIEW: TabView<InboxItem, ReviewerState, AssignedColumn> = {
  tab: "assigned",
  rules: ASSIGNED_RULES,
  columns: ASSIGNED_COLUMNS,
  specs: ASSIGNED_SPECS,
  tinted: ["state", "local", "ci"],
  states: {
    all: ReviewerStateSchema.options,
    label: statesLabel,
    name: (state) => capitalised(STATE_NAMES[state]),
    hint: (state) => (state === "unapproved" ? "GitLab only" : undefined),
  },
  searchHint: "Search by title, project, author or number",
  listing: "Listing what you are asked to review…",
  failure: "Could not list your reviews",
  empty: "Nothing to review.",
};

const AUTHORED_VIEW: TabView<AuthoredInboxItem, ReviewStatus, AuthoredColumn> = {
  tab: "authored",
  rules: AUTHORED_RULES,
  columns: AUTHORED_COLUMNS,
  specs: AUTHORED_SPECS,
  tinted: ["state", "reviewers", "local", "ci"],
  states: {
    all: ReviewStatusSchema.options,
    label: statusesLabel,
    name: (status) => capitalised(STATUS_NAMES[status]),
    hint: (status) => STATUS_HINTS[status],
  },
  searchHint: "Search by title, project, reviewer or number",
  listing: "Listing your change requests…",
  failure: "Could not list your change requests",
  empty: "No open change requests of yours.",
};

const ACTIONS_WIDTH = 88;
const CELL_GAP = spacing[3];

function columnStyle(size: ColumnWidth) {
  return "width" in size ? { width: size.width } : { flex: size.flex, minWidth: size.min };
}

/** The narrowest the table can be with these columns before its cells crowd; anything narrower gets cards. */
function tableWidth<Item, Column extends string>(specs: Record<Column, ColumnSpec<Item>>, columns: readonly Column[]): number {
  const cells = columns.reduce((total, column) => {
    const { size } = specs[column];
    return total + ("width" in size ? size.width : size.min);
  }, 0);
  return cells + ACTIONS_WIDTH + CELL_GAP * columns.length + spacing[3] * 2 + 2;
}

function Cell({ colors, text, color, lines = 1 }: { colors: Colors; text: string; color?: keyof Colors; lines?: number }) {
  return (
    <Text numberOfLines={lines} style={{ color: colors[color ?? "foreground"], fontSize: fontSize.sm, lineHeight: leading(fontSize.sm) }}>
      {text}
    </Text>
  );
}

/** Two lines, since a state or what is kept here can run to a few words. */
function TintedCell({ colors, value }: { colors: Colors; value: Tinted | null }) {
  return value === null ? <Cell colors={colors} text="—" color="foregroundMuted" /> : <Cell colors={colors} text={value.text} color={value.color} lines={2} />;
}

/** The change request's number as its forge writes it, linking to it there. */
function NumberLink({ colors, item }: { colors: Colors; item: Row }) {
  return (
    <ExternalLink href={item.url} accessibilityLabel={`Open ${numberLabel(item.forge, item.number)} on ${FORGE_NAMES[item.forge]}`}>
      <Text style={{ color: colors.accent, fontSize: fontSize.sm, lineHeight: leading(fontSize.sm) }}>{numberLabel(item.forge, item.number)}</Text>
    </ExternalLink>
  );
}

function Title({ colors, item }: { colors: Colors; item: Row }) {
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: spacing[1] }}>
      {item.isDraft ? <Badge colors={colors} text="Draft" /> : null}
      <Text numberOfLines={2} style={{ flexShrink: 1, color: colors.foreground, fontSize: fontSize.base, lineHeight: leading(fontSize.base) }}>
        {item.title}
      </Text>
    </View>
  );
}

function Badge({ colors, text }: { colors: Colors; text: string }) {
  return (
    <View style={{ borderWidth: 1, borderColor: colors.border, borderRadius: radius.sm, paddingHorizontal: spacing[1] }}>
      <Text style={{ color: colors.foregroundMuted, fontSize: fontSize.sm, lineHeight: leading(fontSize.sm) }}>{text}</Text>
    </View>
  );
}

/** How faint a row is that stays only because it was just checked off or unchecked. */
const DIMMED = 0.5;

function CheckOffBox({ colors, item }: { colors: Colors; item: ListedItem }) {
  const { toggle } = useContext(CheckOffContext);
  const checked = item.checkedOff;
  return (
    <Pressable
      onPress={() => toggle(item)}
      accessibilityRole="checkbox"
      accessibilityState={{ checked }}
      accessibilityLabel={`${checked ? "Uncheck" : "Check off"} ${numberLabel(item.forge, item.number)}`}
      hitSlop={spacing[1]}
      style={({ pressed }) => ({
        width: 18,
        height: 18,
        alignItems: "center",
        justifyContent: "center",
        borderRadius: radius.sm,
        borderWidth: 1,
        borderColor: checked ? colors.accent : colors.border,
        backgroundColor: checked ? colors.accent : undefined,
        opacity: pressed ? 0.85 : 1,
      })}
    >
      {checked ? <Text style={{ color: colors.accentForeground, fontSize: fontSize.sm, lineHeight: leading(fontSize.sm) }}>✓</Text> : null}
    </Pressable>
  );
}

/**
 * The one way into the review from a row: a row itself starts nothing, so a click elsewhere on it is safe.
 * Review prepares a review without opening it, so several can be started in a row; Continue makes a closed review a workspace again and opens it.
 */
function StartButton({ colors, item, starts }: { colors: Colors; item: Row; starts: ReviewStarts }) {
  const { local } = item;
  const preparing = local?.preparing != null && local.preparing.phase !== "failed";
  if (starts.requesting(item.url) || preparing) return <Button colors={colors} small label="Starting…" disabled onPress={() => {}} />;
  if (local?.workspaceId != null) {
    const workspaceId = local.workspaceId;
    return <Button colors={colors} small label="Open" onPress={() => starts.open(item.reviewId!, workspaceId)} />;
  }
  const resumes = local != null && local.preparing === null;
  return (
    <Button
      colors={colors}
      small
      primary={local === null}
      label={resumes ? "Continue" : "Review"}
      onPress={() => void starts.start(item.url, { open: resumes, pasted: false })}
    />
  );
}

/** The line under a review being started, from a row or the New review dialog: how it goes, why it was turned down or failed, or where to open it. */
function StartStatus({ colors, url, reviewId, local, label, starts }: { colors: Colors; url: string; reviewId: string | null; local: LocalReview | null; label: string; starts: ReviewStarts }) {
  const rejection = starts.rejection(url);
  if (rejection !== null) return <Note colors={colors} tone="danger" text={rejection} />;
  const line = describePreparing(local);
  if (line !== null) return <Note colors={colors} tone={line.tone === "danger" ? "danger" : undefined} text={line.text} />;
  if (reviewId !== null && starts.unopened(reviewId)) return <Note colors={colors} text={`The workspace for ${label} is ready; open "Review ${label}" from the sidebar.`} />;
  return null;
}

/**
 * A line per review started from the New review dialog that the list does not show, since what was pasted may not be in it.
 * It names the URL until the change request is read, and stays until closed.
 */
function PastedRows({ colors, starts, shown }: { colors: Colors; starts: ReviewStarts; shown: readonly Row[] }) {
  const listed = new Set(shown.map((item) => item.reviewId));
  const rows = starts.pasted.filter((entry) => !listed.has(entry.reviewId));
  if (rows.length === 0) return null;
  return (
    <View style={{ gap: spacing[2] }}>
      {rows.map((entry) => (
        <PastedRow key={entry.reviewId} colors={colors} entry={entry} starts={starts} />
      ))}
    </View>
  );
}

function PastedRow({ colors, entry, starts }: { colors: Colors; entry: Pasted; starts: ReviewStarts }) {
  // Not read yet, as just after the list was read again; null once read is a start this daemon lost.
  const local = starts.local(entry.reviewId, undefined);
  const header = local?.header ?? null;
  const label = header ? numberLabel(header.forge, header.number) : entry.url;
  const preparing = local === undefined || (local !== null && local.preparing !== null && local.preparing.phase !== "failed");
  const guide = local != null && local.preparing === null ? GUIDE_STATES[local.guide] : null;
  return (
    <View style={{ padding: spacing[3], gap: spacing[1], borderWidth: 1, borderColor: colors.border, borderRadius: radius.md }}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: spacing[2] }}>
        <View style={{ flex: 1, flexDirection: "row", alignItems: "center", gap: spacing[2] }}>
          <ExternalLink href={header?.url ?? entry.url} accessibilityLabel={`Open ${label}`}>
            <Text numberOfLines={1} style={{ color: colors.accent, fontSize: fontSize.sm, lineHeight: leading(fontSize.sm) }}>
              {label}
            </Text>
          </ExternalLink>
          {header ? (
            <Text numberOfLines={1} style={{ flexShrink: 1, color: colors.foreground, fontSize: fontSize.base, lineHeight: leading(fontSize.base) }}>
              {header.title}
            </Text>
          ) : null}
        </View>
        {local?.workspaceId != null && !preparing ? <Button colors={colors} small label="Open" onPress={() => starts.open(entry.reviewId, local.workspaceId!)} /> : null}
        {preparing ? null : (
          <Pressable accessibilityRole="button" accessibilityLabel="Dismiss" onPress={() => starts.dismiss(entry.reviewId)} hitSlop={spacing[2]}>
            <Text style={{ color: colors.foregroundMuted, fontSize: fontSize.lg, lineHeight: leading(fontSize.lg) }}>×</Text>
          </Pressable>
        )}
      </View>
      {local === undefined ? <Note colors={colors} text="Starting…" /> : null}
      {local === null ? <Note colors={colors} tone="danger" text={describeProgress({ phase: "unknown", header: null, workspaceId: null, message: null }).text} /> : null}
      <StartStatus colors={colors} url={entry.url} reviewId={entry.reviewId} local={local ?? null} label={label} starts={starts} />
      {guide !== null ? <Note colors={colors} tone={local?.guide === "failed" ? "danger" : undefined} text={guide} /> : null}
    </View>
  );
}

/** How the start from this row is going, under it. */
function RowStatus({ colors, item, starts }: { colors: Colors; item: Row; starts: ReviewStarts }) {
  return <StartStatus colors={colors} url={item.url} reviewId={item.reviewId} local={item.local} label={numberLabel(item.forge, item.number)} starts={starts} />;
}

function Table<Item extends Row, Column extends string>({
  colors,
  items,
  specs,
  columns: shown,
  preferences,
  change,
  starts,
}: {
  colors: Colors;
  items: Item[];
  specs: Record<Column, ColumnSpec<Item>>;
  columns: readonly Column[];
  preferences: Pick<ListFilters<string>, "sort">;
  change: (update: Pick<ListFilters<string>, "sort">) => void;
  starts: ReviewStarts;
}) {
  const now = new Date();
  const { dimmed } = useContext(CheckOffContext);
  const columns = shown.map((id) => ({ id, ...specs[id] }));
  const sortBy = (key: InboxSortKey) =>
    change({ sort: { key, descending: preferences.sort.key === key ? !preferences.sort.descending : true } });

  return (
    <View style={{ borderWidth: 1, borderColor: colors.border, borderRadius: radius.md, overflow: "hidden" }}>
      <View style={{ flexDirection: "row", gap: CELL_GAP, paddingVertical: spacing[2], paddingHorizontal: spacing[3], backgroundColor: colors.surface1 }}>
        {columns.map((column) => {
          const sorted = column.sort !== undefined && preferences.sort.key === column.sort;
          const header = column.header ?? column.label;
          const label = sorted ? `${header} ${preferences.sort.descending ? "↓" : "↑"}` : header;
          const text = (
            <Text
              numberOfLines={1}
              style={{ color: sorted ? colors.foreground : colors.foregroundMuted, fontSize: fontSize.sm, lineHeight: leading(fontSize.sm), fontWeight: "600" }}
            >
              {label}
            </Text>
          );
          return (
            <View key={column.id} style={columnStyle(column.size)}>
              {column.sort === undefined ? (
                text
              ) : (
                <Pressable accessibilityRole="button" onPress={() => sortBy(column.sort!)}>
                  {text}
                </Pressable>
              )}
            </View>
          );
        })}
        <View style={{ width: ACTIONS_WIDTH }} />
      </View>
      {items.map((item) => (
        <View
          key={item.url}
          style={{
            paddingVertical: spacing[2],
            paddingHorizontal: spacing[3],
            borderTopWidth: 1,
            borderTopColor: colors.border,
            gap: spacing[1],
            opacity: dimmed(item) ? DIMMED : 1,
          }}
        >
          <View style={{ flexDirection: "row", gap: CELL_GAP, alignItems: "center" }}>
            {columns.map((column) => (
              <View key={column.id} style={columnStyle(column.size)}>
                {column.cell(item, colors, now)}
              </View>
            ))}
            <View style={{ width: ACTIONS_WIDTH, alignItems: "flex-end" }}>
              <StartButton colors={colors} item={item} starts={starts} />
            </View>
          </View>
          <RowStatus colors={colors} item={item} starts={starts} />
        </View>
      ))}
    </View>
  );
}

/** A row stacked for a narrow screen: the title, then whichever of the other columns are shown, as lines. */
function Card<Item extends Row, Column extends string>({
  colors,
  item,
  specs,
  columns,
  tinted: tintedColumns,
  starts,
}: {
  colors: Colors;
  item: Item;
  specs: Record<Column, ColumnSpec<Item>>;
  columns: readonly Column[];
  tinted: readonly Column[];
  starts: ReviewStarts;
}) {
  const now = new Date();
  const { dimmed } = useContext(CheckOffContext);
  const shown = columns.map((column) => specs[column]);
  const beside = shown.find((spec) => spec.besideTitle);
  const meta = shown.flatMap((spec) => (spec.line === undefined ? [] : [spec.line(item, now)]));
  const tinted = tintedColumns.filter((column) => columns.includes(column)).flatMap((column) => specs[column].tint?.(item) ?? []);

  return (
    <View style={{ padding: spacing[3], gap: spacing[1], borderWidth: 1, borderColor: colors.border, borderRadius: radius.md, opacity: dimmed(item) ? DIMMED : 1 }}>
      {beside !== undefined ? (
        <View style={{ flexDirection: "row", alignItems: "center", gap: spacing[2] }}>
          {beside.cell(item, colors, now)}
          <Title colors={colors} item={item} />
        </View>
      ) : (
        <Title colors={colors} item={item} />
      )}
      <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", columnGap: spacing[1] }}>
        <NumberLink colors={colors} item={item} />
        {meta.length > 0 ? (
          <Text style={{ flexShrink: 1, color: colors.foregroundMuted, fontSize: fontSize.sm, lineHeight: leading(fontSize.sm) }}>· {meta.join(" · ")}</Text>
        ) : null}
      </View>
      {tinted.length > 0 ? (
        <View style={{ flexDirection: "row", flexWrap: "wrap", columnGap: spacing[3] }}>
          {tinted.map((value, index) => (
            <Cell key={index} colors={colors} text={value.text} color={value.color} />
          ))}
        </View>
      ) : null}
      <View style={{ marginTop: spacing[1], alignItems: "flex-start" }}>
        <StartButton colors={colors} item={item} starts={starts} />
      </View>
      <RowStatus colors={colors} item={item} starts={starts} />
    </View>
  );
}
