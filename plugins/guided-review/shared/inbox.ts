import { z } from "zod";
import { ReviewHeaderSchema, START_PHASES } from "./review-header.ts";

/**
 * Where the reviewer stands on a change request they review, in the same words on both forges.
 * `unapproved` is an approval the forge took back, as GitLab does when the author pushes after it.
 */
export const ReviewerStateSchema = z.enum(["requested", "commented", "changes-requested", "approved", "unapproved"]);

/**
 * Where the author's change request stands with its reviewers, combined from each one's latest review, in the same words on both forges.
 * `approval-reset` is an approval taken back by a push; on GitLab, a reviewer revoking their approval reads the same.
 */
export const ReviewStatusSchema = z.enum(["unreviewed", "waiting", "commented", "changes-requested", "approved", "approval-reset"]);

/** The head's CI as one word; null when it has none, or one in a state neither of these is, like a cancelled pipeline. */
export const CiStateSchema = z.enum(["success", "failure", "pending"]);

/** An open change request as a forge lists it, whichever tab of the review list it is on. */
export const ListedChangeRequestSchema = z.object({
  forge: z.enum(["github", "gitlab"]),
  /** The web host, lower-cased: `github.com`. */
  host: z.string(),
  /** `owner/repo`, or a GitLab project path. */
  project: z.string(),
  number: z.number().int(),
  url: z.string(),
  title: z.string(),
  author: z.string(),
  isDraft: z.boolean(),
  createdAt: z.string(),
  updatedAt: z.string(),
  headSha: z.string(),
  additions: z.number().int(),
  deletions: z.number().int(),
  fileCount: z.number().int(),
  ci: CiStateSchema.nullable(),
  /** The viewer's unpublished comments on it; null where the forge cannot count them cheaply. */
  pendingDrafts: z.number().int().nullable(),
});

/** An open change request the reviewer is one of the reviewers of, as a forge lists it. */
export const ReviewRequestSchema = ListedChangeRequestSchema.extend({
  state: ReviewerStateSchema,
  /** The team the review was asked of, `org/team`, when it was not asked of the reviewer by name. */
  viaTeam: z.string().nullable(),
  /**
   * Whether the change request moved on since the reviewer's last review: a push, or being asked
   * again. Null when they never reviewed it, or the forge cannot say.
   */
  changedSinceReview: z.boolean().nullable(),
});

/** A person or team asked to review the author's change request, or who reviewed it, by where their latest review stands. */
export const ReviewerSchema = z.object({
  /** A login, or `org/team` for a team. */
  name: z.string(),
  state: ReviewerStateSchema,
});

/** An open change request the viewer authored, as a forge lists it; `author` is always the viewer. */
export const AuthoredChangeRequestSchema = ListedChangeRequestSchema.extend({
  status: ReviewStatusSchema,
  reviewers: z.array(ReviewerSchema),
  /** Whether a review arrived after the head commit was pushed; null where the forge cannot say. */
  reviewedSinceLastPush: z.boolean().nullable(),
  /** When the newest review arrived; null before any did. */
  latestReviewAt: z.string().nullable(),
});

export type ReviewerState = z.output<typeof ReviewerStateSchema>;
export type ReviewStatus = z.output<typeof ReviewStatusSchema>;
export type CiState = z.output<typeof CiStateSchema>;
export type ReviewRequest = z.output<typeof ReviewRequestSchema>;
export type Reviewer = z.output<typeof ReviewerSchema>;
export type ListedChangeRequest = z.output<typeof ListedChangeRequestSchema>;
export type AuthoredChangeRequest = z.output<typeof AuthoredChangeRequestSchema>;

/**
 * What one host of a forge listed, or why it could not, so one host failing leaves the others listed.
 * Both lists come from one listing, so a host fails for both at once and says so once.
 */
export const ListedHostSchema = z.object({
  forge: z.enum(["github", "gitlab"]),
  host: z.string(),
  /** What the viewer is asked to review. */
  assigned: z.array(ReviewRequestSchema),
  /** What the viewer authored. */
  authored: z.array(AuthoredChangeRequestSchema),
  /** Which of the host's lists has more than was listed. */
  truncated: z.object({ assigned: z.boolean(), authored: z.boolean() }),
  /** Why the host could not be listed, as a sentence; both its lists are then empty. */
  error: z.string().nullable(),
});

export type ListedHost = z.output<typeof ListedHostSchema>;

/**
 * What this plugin has of a change request's review, if the reviewer started one here: the start
 * or Regenerate still running, or how it failed, where its guide stands at the head it was read at,
 * and its workspace while that is open.
 */
export const LocalReviewSchema = z.object({
  /** The change request as the review has it; null until a first start has read it. */
  header: ReviewHeaderSchema.nullable(),
  /** The review's start or Regenerate while it runs, and once it failed. */
  preparing: z.object({ phase: z.enum(START_PHASES), message: z.string().nullable() }).nullable(),
  guide: z.enum(["none", "choosing-scope", "generating", "ready", "failed"]),
  workspaceId: z.string().nullable(),
});

/** What the review list joins to a listed change request, on either tab. */
const JOINED = {
  /** The ID a review of it is kept under, the same on both tabs; null when it cannot be kept. */
  reviewId: z.string().nullable(),
  local: LocalReviewSchema.nullable(),
  /** The viewer set it aside on this tab, the forge none the wiser, until it moves on (`server/inbox-check-offs.ts`). */
  checkedOff: z.boolean(),
};

export const InboxItemSchema = ReviewRequestSchema.extend(JOINED);
export const AuthoredInboxItemSchema = AuthoredChangeRequestSchema.extend(JOINED);

/** What the reviewer saw of a change request when they checked it off. */
export const CheckOffSchema = z.object({ headSha: z.string(), state: ReviewerStateSchema });

/** What the author saw of their change request when they checked it off: where it stood with its reviewers, and when the newest review arrived. */
export const AuthoredCheckOffSchema = z.object({ status: ReviewStatusSchema, latestReviewAt: z.string().nullable() });

/** A check-off set on one tab as of what its row showed, or with null taken back. */
export const CheckOffChangeSchema = z.discriminatedUnion("tab", [
  z.object({ tab: z.literal("assigned"), url: z.string(), checkOff: CheckOffSchema.nullable() }),
  z.object({ tab: z.literal("authored"), url: z.string(), checkOff: AuthoredCheckOffSchema.nullable() }),
]);

/** Every host's review requests and the viewer's own change requests, each joined with the review started here, if any. */
export const InboxSchema = z.object({
  hosts: z.array(ListedHostSchema.omit({ assigned: true, authored: true })),
  assigned: z.array(InboxItemSchema),
  authored: z.array(AuthoredInboxItemSchema),
});

export type LocalReview = z.output<typeof LocalReviewSchema>;
export type CheckOff = z.output<typeof CheckOffSchema>;
export type AuthoredCheckOff = z.output<typeof AuthoredCheckOffSchema>;
export type CheckOffChange = z.output<typeof CheckOffChangeSchema>;
export type InboxItem = z.output<typeof InboxItemSchema>;
export type AuthoredInboxItem = z.output<typeof AuthoredInboxItemSchema>;
export type Inbox = z.output<typeof InboxSchema>;

/** Whether the forge's head moved past the one the review here was read at. */
export function headMoved(item: Pick<ListedChangeRequest, "headSha">, local: LocalReview): boolean {
  return local.header !== null && item.headSha !== "" && item.headSha !== local.header.headSha;
}
