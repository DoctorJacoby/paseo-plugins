import { INBOX_TABS } from "../shared/inbox-preferences.ts";

/**
 * A file kept per tab of the review list, as `{ assigned, authored }`.
 * One written before the list had tabs holds the Assigned tab's alone, flat, and reads as that.
 */
export function byTab(stored: unknown): Record<string, unknown> {
  if (typeof stored !== "object" || stored === null || Array.isArray(stored)) return {};
  return INBOX_TABS.some((tab) => tab in stored) ? (stored as Record<string, unknown>) : { assigned: stored };
}
