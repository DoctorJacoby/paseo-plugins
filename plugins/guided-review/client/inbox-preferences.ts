import { useRpc } from "@getpaseo/plugin/client";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import * as contracts from "../shared/contracts.ts";
import { PLUGIN_ID } from "../shared/identity.ts";
import { DEFAULT_INBOX_PREFERENCES, type InboxPreferences, type InboxTab } from "../shared/inbox-preferences.ts";

export type InboxPreferencesControl<Preferences> = {
  preferences: Preferences;
  change(update: Partial<Preferences>): void;
  /** Why the latest change could not be kept, as a sentence. */
  error: string | null;
};

const QUERY_KEY = [PLUGIN_ID, "inbox-preferences"];

/**
 * One tab's filters, sort and columns as the daemon keeps them.
 * A change shows at once and is saved behind it, with the other tab's, whole; the answer is not read back, since a slower answer to an earlier save would undo a later change.
 */
export function useInboxPreferences<Tab extends InboxTab>(tab: Tab): InboxPreferencesControl<InboxPreferences[Tab]> {
  const getPreferences = useRpc(contracts.getInboxPreferences);
  const savePreferences = useRpc(contracts.saveInboxPreferences);
  const queryClient = useQueryClient();
  const stored = useQuery({ queryKey: QUERY_KEY, queryFn: () => getPreferences({}), staleTime: Infinity });
  const save = useMutation({ mutationFn: savePreferences });

  return {
    preferences: (stored.data ?? DEFAULT_INBOX_PREFERENCES)[tab],
    change(update) {
      const current = queryClient.getQueryData<InboxPreferences>(QUERY_KEY) ?? DEFAULT_INBOX_PREFERENCES;
      const next: InboxPreferences = { ...current, [tab]: { ...current[tab], ...update } };
      queryClient.setQueryData(QUERY_KEY, next);
      save.mutate(next);
    },
    error: save.isError ? (save.error instanceof Error ? save.error.message : String(save.error)) : null,
  };
}
