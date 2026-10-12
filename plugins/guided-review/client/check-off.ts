import { useRpc } from "@getpaseo/plugin/client";
import { useIsMutating, useMutation, useQueryClient } from "@tanstack/react-query";
import { createContext, useState } from "react";
import * as contracts from "../shared/contracts.ts";
import { PLUGIN_ID } from "../shared/identity.ts";
import type { AuthoredInboxItem, CheckOffChange, Inbox, InboxItem } from "../shared/inbox.ts";
import { withCheckedOff, type ListedItem } from "./inbox-filter.ts";

export const INBOX_QUERY_KEY = [PLUGIN_ID, "inbox"];
const MUTATION_KEY = [PLUGIN_ID, "check-off"];

/** What a tab's check-off records of its row, so the server can tell when it came back. */
export type CheckOffRule<Item extends ListedItem> = (item: Item, checkedOff: boolean) => CheckOffChange;

export const ASSIGNED_CHECK_OFF: CheckOffRule<InboxItem> = (item, checkedOff) => ({
  tab: "assigned",
  url: item.url,
  checkOff: checkedOff ? { headSha: item.headSha, state: item.state } : null,
});

export const AUTHORED_CHECK_OFF: CheckOffRule<AuthoredInboxItem> = (item, checkedOff) => ({
  tab: "authored",
  url: item.url,
  checkOff: checkedOff ? { status: item.status, latestReviewAt: item.latestReviewAt } : null,
});

export type CheckOffControl<Item extends ListedItem> = {
  toggle(item: Item): void;
  /** The rows checked off or unchecked since the list was last refreshed, filtered or searched, which stay where they are until then. */
  held: ReadonlySet<string>;
  release(): void;
  /** A check-off on either tab is being saved, so a refresh now could read the list from before it. */
  saving: boolean;
  /** Why the latest check-off could not be kept, as a sentence. */
  error: string | null;
};

/**
 * Checking change requests off one tab of the list and unchecking them.
 * A toggle shows at once in the listed inbox and is saved behind it, and put back if the save fails.
 */
export function useCheckOff<Item extends ListedItem>(rule: CheckOffRule<Item>): CheckOffControl<Item> {
  const setCheckedOff = useRpc(contracts.setCheckedOff);
  const queryClient = useQueryClient();
  const [held, setHeld] = useState<ReadonlySet<string>>(() => new Set());
  const [error, setError] = useState<string | null>(null);
  const mark = ({ tab, url }: CheckOffChange, checkedOff: boolean) =>
    queryClient.setQueryData<Inbox>(INBOX_QUERY_KEY, (inbox) => inbox && withCheckedOff(inbox, tab, url, checkedOff));
  const save = useMutation({
    mutationKey: MUTATION_KEY,
    mutationFn: setCheckedOff,
    onError: (failure, change) => {
      mark(change, change.checkOff === null);
      setError(failure instanceof Error ? failure.message : String(failure));
    },
  });
  const saving = useIsMutating({ mutationKey: MUTATION_KEY }) > 0;

  return {
    toggle(item) {
      const checkedOff = !item.checkedOff;
      const change = rule(item, checkedOff);
      void queryClient.cancelQueries({ queryKey: INBOX_QUERY_KEY });
      mark(change, checkedOff);
      setHeld((rows) => new Set(rows).add(item.url));
      setError(null);
      save.mutate(change);
    },
    held,
    release: () => setHeld(new Set()),
    saving,
    error,
  };
}

/** What a row's checkbox needs from the list, so the column's cell takes no more than every other cell. */
export const CheckOffContext = createContext<{ toggle(item: ListedItem): void; dimmed(item: ListedItem): boolean }>({
  toggle: () => {},
  dimmed: () => false,
});
