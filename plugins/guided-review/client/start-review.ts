import { useRpc } from "@getpaseo/plugin/client";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import * as contracts from "../shared/contracts.ts";
import type { InboxItem, LocalReview } from "../shared/inbox.ts";
import { PLUGIN_ID } from "../shared/identity.ts";
import { openPanelWhenReady } from "./open-panel.ts";
import { isSettled } from "./start-progress.ts";

const POLL_MS = 2_000;

/** A review started from the New review dialog, which gets a line of its own above the list while the list does not show it. */
export type Pasted = { url: string; reviewId: string };

/** Starting reviews from the start screen, as many at once as the reviewer likes: the New review dialog's and every review list row's one job. */
export type ReviewStarts = {
  /**
   * Starts the review `url` names, and with `open` opens its panel once its workspace is ready.
   * `pasted` gives it a line of its own. Answers why it was turned down, or null once it began.
   */
  start(url: string, intent: { open: boolean; pasted: boolean }): Promise<string | null>;
  /** Whether the start of `url` is still being asked for. */
  requesting(url: string): boolean;
  /** Why the latest start of `url` was turned down before it began. */
  rejection(url: string): string | null;
  /** What this plugin has of the review: the latest read of it here, else what the list said. */
  local<Listed extends LocalReview | null | undefined>(reviewId: string | null, listed: Listed): LocalReview | null | Listed;
  /** Opens the review's panel in its workspace. */
  open(reviewId: string, workspaceId: string): void;
  /** Whether the review's panel could not be opened, so the reviewer is to open it from the sidebar. */
  unopened(reviewId: string): boolean;
  pasted: Pasted[];
  dismiss(reviewId: string): void;
  /** Drops what was read here, once the list itself is read again. */
  forget(): void;
};

/**
 * Starts reviews, follows each one's preparation and guide until they settle, and opens a panel only for a start meant to open it.
 * `items` are the listed reviews, whose unsettled ones are followed too, as after the start screen was closed and opened again.
 */
export function useReviewStarts(openPanel: (workspaceId: string) => void, items: readonly Pick<InboxItem, "reviewId" | "local">[]): ReviewStarts {
  const startReview = useRpc(contracts.startReview);
  const getLocalReviews = useRpc(contracts.getLocalReviews);
  const [requesting, setRequesting] = useState<ReadonlySet<string>>(new Set());
  const [rejections, setRejections] = useState<ReadonlyMap<string, string>>(new Map());
  const [read, setRead] = useState<ReadonlyMap<string, LocalReview | null>>(new Map());
  const [opening, setOpening] = useState<ReadonlySet<string>>(new Set());
  const [unopened, setUnopened] = useState<ReadonlySet<string>>(new Set());
  const [pasted, setPasted] = useState<Pasted[]>([]);

  const listed = new Map(items.flatMap((item) => (item.reviewId === null ? [] : [[item.reviewId, item.local] as const])));
  const known = (reviewId: string): LocalReview | null | undefined => (read.has(reviewId) ? read.get(reviewId) : listed.get(reviewId));
  const candidates = new Set([...read.keys(), ...listed.keys(), ...pasted.map((entry) => entry.reviewId)]);
  const following = [...candidates].filter((reviewId) => !isSettled(known(reviewId))).sort();

  useQuery({
    queryKey: [PLUGIN_ID, "local-reviews", following],
    queryFn: async () => {
      const answer = await getLocalReviews({ reviewIds: following });
      setRead((current) => new Map([...current, ...answer.reviews.map((review) => [review.reviewId, review.local] as const)]));
      return answer;
    },
    enabled: following.length > 0,
    refetchInterval: POLL_MS,
  });

  const open = (reviewId: string, workspaceId: string) => {
    setUnopened((current) => without(current, reviewId));
    void openPanelWhenReady(() => openPanel(workspaceId)).then((opened) => {
      if (!opened) setUnopened((current) => new Set([...current, reviewId]));
    });
  };

  useEffect(() => {
    for (const reviewId of opening) {
      const local = known(reviewId);
      if (local?.preparing?.phase === "failed" || local === null) {
        setOpening((current) => without(current, reviewId));
      } else if (local !== undefined && local.preparing === null && local.workspaceId !== null) {
        setOpening((current) => without(current, reviewId));
        open(reviewId, local.workspaceId);
      }
    }
  }, [opening, read, items]);

  const start = async (url: string, intent: { open: boolean; pasted: boolean }) => {
    const target = url.trim();
    setRequesting((current) => new Set([...current, target]));
    setRejections((current) => withoutKey(current, target));
    try {
      const result = await startReview({ url: target });
      if (result.status === "rejected") {
        setRejections((current) => new Map([...current, [target, result.message]]));
        return result.message;
      }
      const { reviewId } = result;
      const before = known(reviewId) ?? null;
      // Read as begun at once, so it is followed from now on rather than from whatever the list said before.
      setRead((current) => new Map([...current, [reviewId, { header: before?.header ?? null, preparing: { phase: "reading", message: null }, guide: before?.guide ?? "none", workspaceId: before?.workspaceId ?? null }]]));
      setUnopened((current) => without(current, reviewId));
      if (intent.open) setOpening((current) => new Set([...current, reviewId]));
      if (intent.pasted) setPasted((current) => [...current.filter((entry) => entry.reviewId !== reviewId), { url: target, reviewId }]);
      return null;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setRejections((current) => new Map([...current, [target, message]]));
      return message;
    } finally {
      setRequesting((current) => without(current, target));
    }
  };

  return {
    start,
    requesting: (url) => requesting.has(url.trim()),
    rejection: (url) => rejections.get(url.trim()) ?? null,
    local: (reviewId, listed) => (reviewId !== null && read.has(reviewId) ? read.get(reviewId)! : listed),
    open,
    unopened: (reviewId) => unopened.has(reviewId),
    pasted,
    dismiss: (reviewId) => setPasted((current) => current.filter((entry) => entry.reviewId !== reviewId)),
    forget: () => setRead(new Map()),
  };
}

function without<T>(set: ReadonlySet<T>, value: T): ReadonlySet<T> {
  const next = new Set(set);
  next.delete(value);
  return next;
}

function withoutKey<K, V>(map: ReadonlyMap<K, V>, key: K): ReadonlyMap<K, V> {
  const next = new Map(map);
  next.delete(key);
  return next;
}
