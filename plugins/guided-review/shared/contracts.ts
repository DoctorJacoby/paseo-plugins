import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";
import { FileDiffSchema } from "./diff.ts";
import { CommentOriginSchema, DraftListSchema, DraftLocationSchema, LinkedDraftSchema, QuoteSchema } from "./drafts.ts";
import { ForeignWorkSchema, REVIEW_SCOPES } from "./foreign-work.ts";
import { GuideStateSchema } from "./guide.ts";
import { InboxPreferencesSchema } from "./inbox-preferences.ts";
import { CheckOffChangeSchema, InboxSchema, LocalReviewSchema } from "./inbox.ts";
import { GuideProgressSchema } from "./progress.ts";
import { ReviewHeaderSchema, START_PHASES } from "./review-header.ts";
import { SubmitResultSchema, VerdictOptionSchema, VerdictSchema } from "./submit.ts";

export const LocalReviewsSchema = z.object({ reviews: z.array(z.object({ reviewId: z.string(), local: LocalReviewSchema.nullable() })) });

export const StartResultSchema = z.discriminatedUnion("status", [
  /** The URL is not one any forge takes; nothing was started. */
  z.object({ status: z.literal("rejected"), message: z.string() }),
  /** A background job is reading the change request and preparing its workspace; follow it by ID. */
  z.object({ status: z.literal("started"), reviewId: z.string() }),
]);

/**
 * Where starting a review has got to. `unknown` is a review this daemon has no record of, which is
 * what one started before a plugin restart and not finished reads as.
 */
export const StartProgressSchema = z.object({
  phase: z.enum(START_PHASES),
  /** Known once the change request has been read. */
  header: ReviewHeaderSchema.nullable(),
  /** Set when `ready`. */
  workspaceId: z.string().nullable(),
  /** Set when `failed`, as a sentence. */
  message: z.string().nullable(),
});

/** An open change request a workspace's branch is the source of, as the reviewer chooses between several. */
export const BranchCandidateSchema = z.object({
  forge: z.enum(["github", "gitlab"]),
  url: z.string(),
  number: z.number().int(),
  title: z.string(),
  author: z.string(),
});

/**
 * Where guiding a workspace's branch has got to, in that workspace's panel. `none` is a branch no
 * open change request comes from; `started` follows the review, which may have gone to a PR
 * workspace, with `note` saying why the branch was left alone.
 */
export const BranchStartSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("finding") }),
  z.object({ status: z.literal("none"), message: z.string() }),
  z.object({ status: z.literal("failed"), message: z.string() }),
  z.object({ status: z.literal("choose"), branch: z.string(), candidates: z.array(BranchCandidateSchema) }),
  z.object({ status: z.literal("started"), reviewId: z.string(), progress: StartProgressSchema, note: z.string().nullable() }),
]);

/**
 * The other change requests' commits the diff shows as the review's, and whether the reviewer wrote
 * it, so has no one to ask about them. `scope` is what the guide at the review's head is written
 * from, while it can be switched: null when its own work cannot be told apart, or no guide is
 * written or being written there yet.
 */
export const ForeignWorkViewSchema = z.object({ work: ForeignWorkSchema, viewerIsAuthor: z.boolean(), scope: z.enum(REVIEW_SCOPES).nullable() });

export const PanelViewSchema = z.discriminatedUnion("status", [
  /** `branch` is set while this workspace's branch is being guided, or once that ended without a guide here. */
  z.object({ status: z.literal("none"), branch: BranchStartSchema.optional() }),
  z.object({
    status: z.literal("ready"),
    reviewId: z.string(),
    header: ReviewHeaderSchema,
    guide: GuideStateSchema,
    /** Why the reviewer's own branch was left alone and the guide lives in this PR workspace instead. */
    note: z.string().optional(),
    foreign: ForeignWorkViewSchema.optional(),
  }),
]);

export const startReview = defineRpc({
  name: "guided-review.review.start",
  input: z.object({ url: z.string() }),
  output: StartResultSchema,
});

/** The open change requests the reviewer reviews on every host, for picking one to start from. */
export const getInbox = defineRpc({
  name: "guided-review.inbox.list",
  input: z.object({}),
  output: InboxSchema,
});

/** What this plugin has of each review, for the review list to follow the ones being prepared or generated without listing again. */
export const getLocalReviews = defineRpc({
  name: "guided-review.inbox.local",
  input: z.object({ reviewIds: z.array(z.string()) }),
  output: LocalReviewsSchema,
});

export const ReviewWorkspacesSchema = z.object({ workspaceIds: z.array(z.string()) });

/** The open workspaces of the reviews started here, which the client gives a button that opens the panel. */
export const getReviewWorkspaces = defineRpc({
  name: "guided-review.review.workspaces",
  input: z.object({}),
  output: ReviewWorkspacesSchema,
});

export const getInboxPreferences = defineRpc({
  name: "guided-review.inbox.preferences",
  input: z.object({}),
  output: InboxPreferencesSchema,
});

/** Saves the review list's filters, sort and columns whole, and answers them as kept. */
export const saveInboxPreferences = defineRpc({
  name: "guided-review.inbox.save-preferences",
  input: InboxPreferencesSchema,
  output: InboxPreferencesSchema,
});

/** Checks a change request off one tab of the review list as of what the row showed, or with null unchecks it. */
export const setCheckedOff = defineRpc({
  name: "guided-review.inbox.check-off",
  input: CheckOffChangeSchema,
  output: z.null(),
});

export const getStartProgress = defineRpc({
  name: "guided-review.review.progress",
  input: z.object({ reviewId: z.string() }),
  output: StartProgressSchema,
});

/**
 * Guides the open change request the workspace's branch is the source of: in that workspace once its
 * branch is fast-forwarded to the head, in a PR workspace when the branch cannot be. Returns at once;
 * the panel follows it through `getPanel`. `url` is the reviewer's choice when there were several.
 */
export const startBranchReview = defineRpc({
  name: "guided-review.review.start-branch",
  input: z.object({ workspaceId: z.string(), url: z.string().nullable() }),
  output: BranchStartSchema,
});

/** The panel has only its workspace's ID, so this is how it finds the review it belongs to. */
export const getPanel = defineRpc({
  name: "guided-review.panel.get",
  input: z.object({ workspaceId: z.string() }),
  output: PanelViewSchema,
});

/**
 * Generates the review's guide again, with a new guide agent: the panel's retry after a failure.
 * Returns at once; the panel follows the generation through `getPanel`.
 */
export const generateGuide = defineRpc({
  name: "guided-review.guide.generate",
  input: z.object({ reviewId: z.string() }),
  output: GuideStateSchema,
});

/**
 * A part of the guide the panel acts on: a node, or a changed file the guide keeps outside its
 * nodes, in its Supporting or Unsorted group. The server looks the rest up in the stored guide, so
 * what it answers with is what the guide says rather than what the panel sent.
 */
export const GuideSubjectSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("node"), nodeId: z.string() }),
  z.object({ kind: z.literal("file"), path: z.string() }),
]);

export const AskResultSchema = z.discriminatedUnion("status", [
  /** The prompt is in the guide agent's chat, which the panel then opens. */
  z.object({ status: z.literal("sent"), agentId: z.string() }),
  /** Nothing was sent; `message` says why, as a sentence. `agentId` is set while there is an agent to open. */
  z.object({ status: z.literal("not-sent"), agentId: z.string().nullable(), message: z.string() }),
]);

/**
 * The code a subject covers, ready to draw: a node's files in reading order, each cut down to the
 * node's hunks, or what no node covers of a changed file, its whole diff or the rest of it, as a
 * Supporting or Unsorted entry shows it.
 */
export const NodeDiffSchema = z.object({
  /** The head the guide, and so these hunks, were read at. */
  headSha: z.string(),
  files: z.array(FileDiffSchema),
});

/** The hunks of a node, or of a changed file, of the review's current guide; fails while the guide is not ready. */
export const getNodeDiff = defineRpc({
  name: "guided-review.guide.node-diff",
  input: z.object({ reviewId: z.string(), subject: GuideSubjectSchema }),
  output: NodeDiffSchema,
});

/** A syntax palette: a colour for each role Paseo's highlighter gives a token. */
export const SyntaxPaletteSchema = z.record(z.string(), z.string());

/** The syntax palettes the diffs are coloured with, one for a dark theme and one for a light one. */
export const SyntaxColorsSchema = z.object({ dark: SyntaxPaletteSchema, light: SyntaxPaletteSchema });

/** The palettes of the syntax theme `theme` names, Paseo's default for one it does not have. */
export const getSyntaxColors = defineRpc({
  name: "guided-review.syntax-colors",
  input: z.object({ theme: z.string() }),
  output: SyntaxColorsSchema,
});

/** Paseo's syntax themes, which the setting offers. */
export const listSyntaxThemes = defineRpc({
  name: "guided-review.syntax-themes",
  input: z.object({}),
  output: z.object({ themes: z.array(z.object({ id: z.string(), label: z.string() })) }),
});

/**
 * The reviewer's progress through the guide the panel shows, the one at the review's head SHA; null
 * while that guide is not ready.
 */
export const getProgress = defineRpc({
  name: "guided-review.progress.get",
  input: z.object({ reviewId: z.string() }),
  output: GuideProgressSchema.nullable(),
});

/**
 * Marks subjects of the guide at `headSha` understood, or clears their marks, all in one write: one card's, or a whole group's.
 * The subjects are the ones "Ask about this" takes: a node, or a Supporting or Unsorted entry. Returns the progress after.
 */
export const setUnderstood = defineRpc({
  name: "guided-review.progress.set",
  input: z.object({ reviewId: z.string(), headSha: z.string(), subjects: z.array(GuideSubjectSchema).min(1), understood: z.boolean() }),
  output: GuideProgressSchema,
});

/**
 * The reviewer's drafts on the change request, as the forge has them, including ones started in
 * its web UI. Drafts live only on the forge, so this is read afresh every time. Each comes with the
 * node of the panel's guide it was written from, which only this plugin knows; null for the rest.
 */
export const listDrafts = defineRpc({
  name: "guided-review.drafts.list",
  input: z.object({ reviewId: z.string() }),
  output: DraftListSchema,
});

/**
 * Saves a comment as a forge draft at once, unpublished until the review is submitted. The location
 * names lines of the diff the panel drew at `headSha`, the head of the guide it showed, which the
 * server looks up at that head; a head the review has since been regenerated away from is refused.
 */
export const createDraft = defineRpc({
  name: "guided-review.drafts.create",
  input: z.object({
    reviewId: z.string(),
    headSha: z.string(),
    location: DraftLocationSchema,
    body: z.string(),
    /**
     * The part of the guide at `headSha` the comment was written from: a node's own comment, one on
     * code drawn in a node, or one on the overview. Kept here, keyed by the draft's ID, and never posted.
     */
    from: CommentOriginSchema.nullable().optional(),
    /** The passage of that part the reviewer highlighted to comment on; kept with the origin, never posted. */
    quote: QuoteSchema.nullable().optional(),
  }),
  output: LinkedDraftSchema,
});

export const updateDraft = defineRpc({
  name: "guided-review.drafts.update",
  input: z.object({ reviewId: z.string(), draftId: z.string(), body: z.string() }),
  output: z.null(),
});

export const deleteDraft = defineRpc({
  name: "guided-review.drafts.delete",
  input: z.object({ reviewId: z.string(), draftId: z.string() }),
  output: z.null(),
});

/**
 * Whether the PR/MR's head has moved on since the panel's guide was written, as the forge has it
 * now: what the "PR updated since this guide" banner shows, and what a verdict needs to know.
 */
export const HeadCheckSchema = z.object({
  /** The head the panel's guide, and its header, were read at. */
  guideHeadSha: z.string(),
  /** Where the forge has the head now; null when it could not be asked, with `message` saying why. */
  forgeHeadSha: z.string().nullable(),
  /** New commits were pushed, or the branch was rewritten, since the guide was written. False when unknown. */
  moved: z.boolean(),
  /** How many commits came after the guide's head, when it moved and that could be read. */
  newCommits: z.number().nullable(),
  /** The guide's head is no longer among the PR/MR's commits: it was force-pushed or rebased away. */
  rewritten: z.boolean(),
  /** The state the forge has the PR/MR in now; null when it could not be asked. */
  state: z.enum(["open", "closed", "merged"]).nullable(),
  /** The description as the forge has it now, which an edit changes without a push; null when it could not be asked. */
  description: z.string().nullable(),
  /** Why the forge could not be asked, as a sentence. */
  message: z.string().nullable(),
});

/**
 * Asks the forge where the review's head is now. Nothing changes on its own when it has moved: the
 * panel shows a banner and `regenerateGuide` is the only way to a guide at the new head.
 */
/**
 * Has the review's guide written from `scope`: the whole diff, or only the files the change request's
 * own work changes, when its own work can be told from other change requests'. The choice holds for
 * every later head. Returns at once; the panel follows the generation through `getPanel`.
 */
export const chooseScope = defineRpc({
  name: "guided-review.review.scope",
  input: z.object({ reviewId: z.string(), scope: z.enum(REVIEW_SCOPES) }),
  output: GuideStateSchema,
});

/**
 * Posts the reviewer's comment asking the author to take other change requests' commits out of the
 * diff, as a thread the author resolves where the forge has one. Refused on the reviewer's own change
 * request and on one that carries none.
 */
export const postHeadsUp = defineRpc({
  name: "guided-review.review.heads-up",
  input: z.object({ reviewId: z.string(), body: z.string() }),
  output: z.null(),
});

export const checkHead = defineRpc({
  name: "guided-review.review.head",
  input: z.object({ reviewId: z.string() }),
  output: HeadCheckSchema,
});

/** The PR/MR description, in the author's Markdown, as it was read at the head of the guide the panel shows. */
export const DescriptionSchema = z.object({
  headSha: z.string(),
  description: z.string(),
  /** The project's web URL, which a relative link or image in the description is relative to. */
  projectUrl: z.string(),
});

export const getDescription = defineRpc({
  name: "guided-review.review.description",
  input: z.object({ reviewId: z.string() }),
  output: DescriptionSchema,
});

export const DescriptionImageSchema = z.discriminatedUnion("status", [
  /** The image's bytes, base64-encoded for a `data:` URI, and its size in pixels as its header gives it. */
  z.object({ status: z.literal("image"), mimeType: z.string(), base64: z.string(), width: z.number(), height: z.number() }),
  /** Not drawn, so the panel links it instead; `message` says why, as a sentence. */
  z.object({ status: z.literal("unavailable"), message: z.string() }),
]);

/**
 * An image in the description, read on the daemon with the forge CLI's login, since a private
 * repository's attachments need one. `url` is absolute; one that is no attachment of the PR/MR is
 * `unavailable`, never fetched.
 */
export const getDescriptionImage = defineRpc({
  name: "guided-review.review.description-image",
  input: z.object({ reviewId: z.string(), url: z.string() }),
  output: DescriptionImageSchema,
});

/**
 * "Regenerate": reads the PR/MR at its current head, brings the guide's workspace to that head, and
 * generates a guide for it, carrying the reviewer's marks over to nodes whose code did not change.
 * Returns at once; the panel follows it through `getStartProgress`, whose `workspaceId` is the
 * workspace the new guide lives in, which is a new PR workspace when the old one could not be moved.
 */
export const regenerateGuide = defineRpc({
  name: "guided-review.guide.regenerate",
  input: z.object({ reviewId: z.string() }),
  output: StartResultSchema,
});

/** What the Finish review step opens on; the drafts it lists are `listDrafts`'. */
export const FinishViewSchema = z.object({
  /** The review body as it is kept until submit: on the pending review on GitHub, here on GitLab. */
  body: z.string(),
  /** Every verdict, on offer or not, from the head as the forge has it now. */
  verdicts: z.array(VerdictOptionSchema),
  /** The head check the verdicts were decided by, which the panel's banner then shows too. */
  head: HeadCheckSchema,
});

export const getFinish = defineRpc({
  name: "guided-review.review.finish",
  input: z.object({ reviewId: z.string() }),
  output: FinishViewSchema,
});

/** Keeps the review body until submit, where the forge keeps it or, on a forge that keeps none, here. */
export const saveReviewBody = defineRpc({
  name: "guided-review.review.body",
  input: z.object({ reviewId: z.string(), body: z.string() }),
  output: z.null(),
});

/**
 * Publishes the drafts and the body with the verdict. The head is checked with the forge again first,
 * and a verdict not on offer then is refused with nothing sent; `headSha` is the head of the guide
 * the panel showed, and one the review has since been regenerated away from is refused too.
 * `forgeHeadSha` is the forge head the panel's Finish review step read, and an Approve or Request
 * changes is refused when the head now warns of another, so it goes out only under the warning shown.
 */
export const submitReview = defineRpc({
  name: "guided-review.review.submit",
  input: z.object({ reviewId: z.string(), headSha: z.string(), forgeHeadSha: z.string().nullable(), verdict: VerdictSchema, body: z.string() }),
  output: SubmitResultSchema,
});

/** Throws away the pending review, its drafts and its body. */
export const discardReview = defineRpc({
  name: "guided-review.review.discard",
  input: z.object({ reviewId: z.string() }),
  output: z.null(),
});

export type FinishView = z.output<typeof FinishViewSchema>;

export type HeadCheck = z.output<typeof HeadCheckSchema>;
export type Description = z.output<typeof DescriptionSchema>;
export type DescriptionImage = z.output<typeof DescriptionImageSchema>;

/**
 * What a comment box is for, as "Suggest wording" and "Ask agent" name it: a comment on code at a draft location, or a general one, on the change as a whole, about a node or the overview, either of which can come from a passage of it the reviewer highlighted.
 * The server looks the lines and the guide's nodes up itself, as for a `GuideSubject`.
 */
export const CommentSubjectSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("code"), location: DraftLocationSchema }),
  z.object({ kind: z.literal("node"), nodeId: z.string(), quote: QuoteSchema.nullable().optional() }),
  z.object({ kind: z.literal("overview"), quote: QuoteSchema.nullable().optional() }),
]);

/**
 * Where a "Suggest wording" request has got to. `ready` carries the text for the box, which nothing
 * saves; `failed` says why there is none, as a sentence.
 */
export const SuggestionSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("running"), suggestionId: z.string() }),
  z.object({ status: z.literal("ready"), body: z.string() }),
  z.object({ status: z.literal("failed"), message: z.string() }),
]);

/**
 * Has the guide agent word a comment from where it goes and `prompt`, whatever the reviewer typed.
 * The agent can take longer than an RPC may, so this starts it and the panel follows it through
 * `getSuggestion`. Only an idle agent is asked; nothing is saved or posted. As for `createDraft`,
 * `headSha` is the head of the guide the panel drew, and one the review has been regenerated away
 * from is refused.
 */
export const suggestWording = defineRpc({
  name: "guided-review.drafts.suggest",
  input: z.object({ reviewId: z.string(), headSha: z.string(), subject: CommentSubjectSchema, prompt: z.string() }),
  output: SuggestionSchema,
});

/** A suggestion `suggestWording` started; a finished one is handed out once. */
export const getSuggestion = defineRpc({
  name: "guided-review.drafts.suggestion",
  input: z.object({ suggestionId: z.string() }),
  output: SuggestionSchema,
});

/**
 * "Ask agent": sends the guide agent the reviewer's `question` about what a comment box is on, instead
 * of saving it as a draft, for the reviewer to follow up in its chat. "Ask about this" sends through
 * it too, about a node or a Supporting or Unsorted file as a whole. Only an idle agent is sent to,
 * because a prompt to a busy one would interrupt its turn. As for `suggestWording`, `headSha` is the
 * head of the guide the panel drew, and one the review has been regenerated away from is refused.
 */
export const askQuestion = defineRpc({
  name: "guided-review.guide.question",
  input: z.object({ reviewId: z.string(), headSha: z.string(), subject: CommentSubjectSchema, question: z.string() }),
  output: AskResultSchema,
});

export type ReviewHeader = z.output<typeof ReviewHeaderSchema>;
export type NodeDiff = z.output<typeof NodeDiffSchema>;
export type SyntaxPalette = z.output<typeof SyntaxPaletteSchema>;
export type SyntaxColors = z.output<typeof SyntaxColorsSchema>;
export type StartResult = z.output<typeof StartResultSchema>;
export type StartPhase = (typeof START_PHASES)[number];
export type LocalReviews = z.output<typeof LocalReviewsSchema>;
export type ReviewWorkspaces = z.output<typeof ReviewWorkspacesSchema>;
export type StartProgress = z.output<typeof StartProgressSchema>;
export type PanelView = z.output<typeof PanelViewSchema>;
export type ForeignWorkView = z.output<typeof ForeignWorkViewSchema>;
export type GuideSubject = z.output<typeof GuideSubjectSchema>;
export type AskResult = z.output<typeof AskResultSchema>;
export type CommentSubject = z.output<typeof CommentSubjectSchema>;
export type Suggestion = z.output<typeof SuggestionSchema>;

/** Tells one subject apart from another in the panel, as for its "Ask about this" and its code. */
export function subjectKey(subject: GuideSubject): string {
  return subject.kind === "node" ? `node:${subject.nodeId}` : `file:${subject.path}`;
}
export type BranchCandidate = z.output<typeof BranchCandidateSchema>;
export type BranchStart = z.output<typeof BranchStartSchema>;
