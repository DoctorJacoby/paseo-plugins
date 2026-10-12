import { randomUUID } from "node:crypto";
import path from "node:path";
import type {
  AskResult,
  BranchStart,
  CommentSubject,
  Description,
  DescriptionImage,
  FinishView,
  GuideSubject,
  HeadCheck,
  LocalReviews,
  NodeDiff,
  PanelView,
  ReviewWorkspaces,
  StartProgress,
  StartResult,
  Suggestion,
  SyntaxColors,
} from "../shared/contracts.ts";
import type { FileDiff } from "../shared/diff.ts";
import type { CheckOffChange, Inbox } from "../shared/inbox.ts";
import type { InboxPreferences } from "../shared/inbox-preferences.ts";
import type { CommentOrigin, DraftList, DraftLocation, LinkedDraft } from "../shared/drafts.ts";
import type { CoveredCode, GuideState, LayeredGuide } from "../shared/guide.ts";
import { canNarrow, changeRequestKind, type ReviewScope } from "../shared/foreign-work.ts";
import { summariseProgress, type GuideProgress } from "../shared/progress.ts";
import type { SubmitResult, Verdict, VerdictOption } from "../shared/submit.ts";
import { commentSubjectContext, type CommentSubjectContext } from "./comment-subject.ts";
import { DiffHighlighter, syntaxColors, syntaxThemes } from "./diff-highlight.ts";
import { entryCode, resolveCode } from "./diff.ts";
import { errorMessage } from "./error-message.ts";
import { imageInfo } from "./image-info.ts";
import { ForgeError, type BranchChangeRequest, type ChangeRequestHead, type ChangeRequestRef, type CommitsSince, type Forge } from "./forge/port.ts";
import { GuideAgentError, type GuideAgentPort } from "./guide-agent/port.ts";
import { runStructured } from "./guide-agent/structured.ts";
import { GuideGenerations, isReady, marksOf } from "./guide-generation.ts";
import { oneAtATimePer } from "./one-at-a-time.ts";
import { regeneratedAway, ReviewDrafts } from "./review-drafts.ts";
import { ReviewInbox } from "./review-inbox.ts";
import { InboxCheckOffsFile } from "./inbox-check-offs.ts";
import { InboxPreferencesFile } from "./inbox-preferences.ts";
import { isFinished, ReviewPreparation, startProgressAt } from "./review-preparation.ts";
import { questionPrompt } from "./question-prompt.ts";
import { ReviewStore, type ProgressRecord, type ReviewRecord } from "./review-store.ts";
import { verdictOptions, warnedOfAnotherHead } from "./submit-rules.ts";
import { WordingSchema, wordingPrompt } from "./wording-prompt.ts";
import type { ReviewWorkspace, WorkspaceCheckout, WorkspacePort } from "./workspaces/port.ts";

export type ReviewServiceOptions = {
  /** Every forge a URL may belong to; the first to claim it reads it. */
  forges: readonly Forge[];
  workspaces: WorkspacePort;
  guideAgents: GuideAgentPort;
  /** Where reviews and the clones this plugin makes are kept. */
  dataDirectory: string;
  now?: () => Date;
  log?: (message: string) => void;
};

/** Guiding a workspace's branch, from finding its change request to the review's own job. */
type BranchJob = { state: BranchState; done: Promise<void> };
type BranchState =
  | { status: "finding" }
  | { status: "none" | "failed"; message: string }
  | { status: "choose"; checkout: LocalCheckout; forge: Forge; candidates: BranchChangeRequest[] }
  | { status: "started"; reviewId: string };
/** A workspace on a branch, with the repository its `origin` names. */
type LocalCheckout = WorkspaceCheckout & { branch: string; repository: NonNullable<WorkspaceCheckout["repository"]> };
/** A "Suggest wording" request to the guide agent `agentId`. */
type SuggestionJob = { agentId: string; state: Suggestion; done: Promise<void> };

/**
 * The plugin's top level: every RPC the panel and the start screen call is a method here, and it
 * reaches the outside world only through the ports it is given, which is what the tests replace.
 * The work behind the larger ones lives in the modules it composes: `ReviewPreparation` reads a change
 * request and gives it a workspace, `GuideGenerations` has its guide written, `ReviewDrafts`
 * keeps the drafts and the review body, and `ReviewInbox` lists what the reviewer reviews.
 *
 * Anything that can outlast Paseo's 30-second RPC limit — reading a large PR, cloning, creating a
 * worktree — runs as a background job the caller follows by ID.
 */
export class ReviewService {
  readonly #forges: readonly Forge[];
  readonly #workspaces: WorkspacePort;
  readonly #guideAgents: GuideAgentPort;
  readonly #store: ReviewStore;
  readonly #now: () => Date;
  readonly #log: (message: string) => void;
  readonly #guides: GuideGenerations;
  readonly #preparation: ReviewPreparation;
  readonly #drafts: ReviewDrafts;
  readonly #inbox: ReviewInbox;
  readonly #inboxPreferences: InboxPreferencesFile;
  readonly #checkOffs: InboxCheckOffsFile;
  /** The latest branch guiding asked for in each workspace, by workspace ID. */
  readonly #branchStarts = new Map<string, BranchJob>();
  /** Writes of each guide's marks, by review and head SHA, one at a time. */
  readonly #progressWrites = oneAtATimePer<string>();
  readonly #highlighter = new DiffHighlighter();
  /** "Suggest wording" requests, by suggestion ID, until the panel has read how they ended. */
  readonly #suggestions = new Map<string, SuggestionJob>();

  constructor(options: ReviewServiceOptions) {
    this.#forges = options.forges;
    this.#workspaces = options.workspaces;
    this.#guideAgents = options.guideAgents;
    this.#store = new ReviewStore(options.dataDirectory);
    this.#now = options.now ?? (() => new Date());
    this.#log = options.log ?? (() => {});
    const shared = { store: this.#store, now: this.#now, log: this.#log };
    this.#guides = new GuideGenerations({ ...shared, guideAgents: this.#guideAgents, workspaces: this.#workspaces });
    this.#preparation = new ReviewPreparation({
      ...shared,
      workspaces: this.#workspaces,
      guides: this.#guides,
      clones: path.join(options.dataDirectory, "clones"),
    });
    this.#drafts = new ReviewDrafts({ store: this.#store, guides: this.#guides });
    this.#checkOffs = new InboxCheckOffsFile(options.dataDirectory);
    this.#inbox = new ReviewInbox({
      forges: this.#forges,
      store: this.#store,
      preparation: this.#preparation,
      guides: this.#guides,
      workspaces: this.#workspaces,
      checkOffs: this.#checkOffs,
      log: this.#log,
    });
    this.#inboxPreferences = new InboxPreferencesFile(options.dataDirectory);
  }

  /** The open change requests the reviewer reviews on every forge and host, with the reviews started here. */
  async inbox(): Promise<Inbox> {
    return this.#inbox.list();
  }

  async localReviews({ reviewIds }: { reviewIds: string[] }): Promise<LocalReviews> {
    return { reviews: await Promise.all(reviewIds.map(async (reviewId) => ({ reviewId, local: await this.#inbox.local(reviewId) }))) };
  }

  async reviewWorkspaces(): Promise<ReviewWorkspaces> {
    const records = await this.#store.list();
    const active = await Promise.all(records.map((record) => this.#workspaces.isActive(record.workspace.id)));
    return { workspaceIds: records.filter((_, index) => active[index]).map((record) => record.workspace.id).sort() };
  }

  async inboxPreferences(): Promise<InboxPreferences> {
    return this.#inboxPreferences.read();
  }

  async saveInboxPreferences(preferences: InboxPreferences): Promise<InboxPreferences> {
    return this.#inboxPreferences.save(preferences);
  }

  async setCheckedOff(change: CheckOffChange): Promise<null> {
    await this.#checkOffs.set(change);
    return null;
  }

  /**
   * Starts a review of the change request `url` names: reads it, then gives it a workspace — the one
   * it already has if that is still open, a new PR workspace otherwise.
   */
  async start({ url }: { url: string }): Promise<StartResult> {
    let match: { forge: Forge; ref: ChangeRequestRef } | null;
    try {
      match = await this.#match(url);
    } catch (error) {
      // A URL a forge claims but cannot read from here, like one on a host its CLI is not logged in to.
      if (error instanceof ForgeError) return { status: "rejected", message: error.message };
      throw error;
    }
    if (match === null) {
      const hints = this.#forges.map((forge) => forge.urlHint).join(", or ");
      return { status: "rejected", message: `That is not ${hints}.` };
    }

    return { status: "started", reviewId: this.#preparation.begin(match.forge, match.ref, null) };
  }

  /**
   * Guides the open change request the workspace's branch is the source of, in the background: finds
   * it, has the reviewer choose when there are several, then starts its review with the workspace
   * as the one to attach to. `url` is that choice. A branch guiding still running is followed.
   */
  async startBranch({ workspaceId, url }: { workspaceId: string; url: string | null }): Promise<BranchStart> {
    const current = this.#branchStarts.get(workspaceId);
    if (current && (await this.#branchRunning(current))) return this.#branchView(current);

    const job: BranchJob = { state: { status: "finding" }, done: Promise.resolve() };
    const chosen = current?.state.status === "choose" ? current.state : null;
    const candidate = chosen?.candidates.find((entry) => entry.ref.url === url);
    this.#branchStarts.set(workspaceId, job);
    if (chosen && candidate) {
      job.state = { status: "started", reviewId: this.#preparation.begin(chosen.forge, candidate.ref, ownWorkspace(chosen.checkout)) };
    } else {
      job.done = this.#findBranch(workspaceId, job).catch((error: unknown) => {
        const message = errorMessage(error);
        this.#log(`Finding the PR or MR of ${workspaceId}'s branch failed: ${message}`);
        job.state = { status: "failed", message };
      });
    }
    return this.#branchView(job);
  }

  /** Where a start or a Regenerate of the review has got to, as the start screen and the panel follow it. */
  async startProgress({ reviewId }: { reviewId: string }): Promise<StartProgress> {
    const running = this.#preparation.progressOf(reviewId);
    if (running) return running;
    const record = await this.#store.get(reviewId);
    if (record === null) return startProgressAt("unknown");
    return { ...startProgressAt("ready"), header: record.header, workspaceId: record.workspace.id };
  }

  async panel({ workspaceId }: { workspaceId: string }): Promise<PanelView> {
    const record = await this.#store.findByWorkspace(workspaceId);
    if (record === null) {
      const branch = this.#branchStarts.get(workspaceId);
      return branch ? { status: "none", branch: await this.#branchView(branch) } : { status: "none" };
    }
    return {
      status: "ready",
      reviewId: record.id,
      header: record.header,
      guide: await this.#guides.state(record),
      ...(record.note ? { note: record.note } : {}),
      ...(record.foreign ? { foreign: { work: record.foreign, viewerIsAuthor: viewerIsAuthor(record), scope: await this.#switchableScope(record) } } : {}),
    };
  }

  /**
   * Generates the review's guide again with a new guide agent, archiving the one before it, unless a
   * generation is running already, which is then the one followed.
   */
  async generateGuide({ reviewId }: { reviewId: string }): Promise<GuideState> {
    return this.#guides.again(await this.#record(reviewId));
  }

  /**
   * Where the forge has the review's head now, against the head of the guide the panel shows. The
   * "PR updated since this guide" banner is `moved`, and so is what keeps a verdict from applying to
   * code the guide did not explain. A forge that cannot be asked is reported, not thrown, and reads
   * as not moved, so a flaky network does not put a banner up.
   */
  async checkHead({ reviewId }: { reviewId: string }): Promise<HeadCheck> {
    const record = await this.#record(reviewId);
    const guideHeadSha = record.header.headSha;
    const forge = this.#forgeFor(record.ref);
    let head: ChangeRequestHead;
    try {
      head = await forge.fetchHead(record.ref);
    } catch (error) {
      if (!(error instanceof ForgeError)) throw error;
      const message = `Could not check ${record.ref.url} for new commits: ${error.message}`;
      this.#log(message);
      return { guideHeadSha, forgeHeadSha: null, moved: false, newCommits: null, rewritten: false, state: null, description: null, message };
    }
    const moved = head.headSha !== guideHeadSha;
    const since = moved ? await this.#commitsSince(forge, record.ref, guideHeadSha) : null;
    return {
      guideHeadSha,
      forgeHeadSha: head.headSha,
      moved,
      newCommits: since?.kind === "after" ? since.count : null,
      rewritten: since?.kind === "rewritten",
      state: head.state,
      description: head.description,
      message: null,
    };
  }

  async chooseScope({ reviewId, scope }: { reviewId: string; scope: ReviewScope }): Promise<GuideState> {
    const record = await this.#record(reviewId);
    if (!canNarrow(record.foreign)) throw new Error(`The ${changeRequestKind(record.ref.forge)}'s own work cannot be told apart, so its guide is of the whole diff.`);
    if (this.#guides.running(record)) throw new Error("The guide is being written; choose again once it is done.");
    const chosen: ReviewRecord = { ...record, scope };
    await this.#store.update(chosen);
    const stored = await this.#store.getGuide(chosen.id, chosen.header.headSha);
    const written = stored !== null && stored.workspaceId === chosen.workspace.id;
    if (written && (stored.scope ?? "full") !== this.#guides.scopeOf(chosen)) return this.#guides.rescope(chosen);
    return this.#guides.state(chosen);
  }

  /** What the guide at the review's head is written from, while the reviewer can switch it: see `ForeignWorkViewSchema`. */
  async #switchableScope(record: ReviewRecord): Promise<ReviewScope | null> {
    if (!canNarrow(record.foreign) || this.#guides.running(record)) return null;
    const stored = await this.#store.getGuide(record.id, record.header.headSha);
    return stored !== null && stored.workspaceId === record.workspace.id ? (stored.scope ?? "full") : null;
  }

  async postHeadsUp({ reviewId, body }: { reviewId: string; body: string }): Promise<null> {
    const record = await this.#record(reviewId);
    const kind = changeRequestKind(record.ref.forge);
    if (viewerIsAuthor(record)) throw new Error(`This is your own ${kind}, so there is no author to ask.`);
    if (record.foreign === undefined) throw new Error(`This ${kind} carries no other ${kind}'s commits.`);
    if (body.trim() === "") throw new Error("The comment is empty.");
    await this.#forgeFor(record.ref).startDiscussion(record.ref, body.trim());
    return null;
  }

  /** The description as it was read at the review's head, which is the head of the guide the panel shows. */
  async description({ reviewId }: { reviewId: string }): Promise<Description> {
    const record = await this.#record(reviewId);
    const { headSha } = record.header;
    const changeRequest = await this.#store.snapshot(reviewId, headSha);
    if (changeRequest === null) throw new Error(`The review has no copy of ${record.ref.url} at ${headSha}. Regenerate the guide.`);
    return { headSha, description: changeRequest.description, projectUrl: `https://${record.ref.host}/${record.ref.project}` };
  }

  async descriptionImage({ reviewId, url }: { reviewId: string; url: string }): Promise<DescriptionImage> {
    const record = await this.#record(reviewId);
    let base64: string | null;
    try {
      base64 = await this.#forgeFor(record.ref).fetchAttachment(record.ref, url, MAX_IMAGE_BYTES);
    } catch (error) {
      if (!(error instanceof ForgeError)) throw error;
      this.#log(`Could not fetch the image ${url} in ${record.ref.url}: ${error.message}`);
      return { status: "unavailable", message: error.message };
    }
    if (base64 === null) return { status: "unavailable", message: "It is hosted elsewhere, so it opens in the browser." };
    const image = imageInfo(Buffer.from(base64, "base64"));
    if (image === null) return { status: "unavailable", message: "It is not a PNG, JPEG, GIF or WebP image, which is all the panel draws." };
    return { status: "image", ...image, base64 };
  }

  /** A count the forge cannot give is left out of the head check rather than failing it. */
  async #commitsSince(forge: Forge, ref: ChangeRequestRef, sha: string): Promise<CommitsSince | null> {
    try {
      return await forge.commitsSince(ref, sha);
    } catch (error) {
      if (!(error instanceof ForgeError)) throw error;
      this.#log(`Could not count the commits on ${ref.url} since ${sha}: ${error.message}`);
      return null;
    }
  }

  /**
   * "Regenerate": reads the change request at its current head, brings the guide's workspace there
   * and generates the guide for that head, as a background job the panel follows through `startProgress`.
   * The only way to a guide at a new head: a start with the head moved keeps the guide it has.
   */
  async regenerate({ reviewId }: { reviewId: string }): Promise<StartResult> {
    let record: ReviewRecord;
    try {
      record = await this.#record(reviewId);
    } catch (error) {
      return { status: "rejected", message: unknownReview(error) };
    }
    return { status: "started", reviewId: this.#preparation.begin(this.#forgeFor(record.ref), record.ref, null, "regenerate") };
  }

  /**
   * "Ask agent": sends the guide agent the reviewer's `question` about what their comment box is on,
   * for them to follow up in the agent's chat. As for `suggestWording`, the subject's lines are those
   * of the guide the panel drew at `headSha`, and one from a guide Regenerate has replaced is refused.
   */
  async askQuestion({
    reviewId,
    headSha: drawnAt,
    subject,
    question,
  }: {
    reviewId: string;
    headSha: string;
    subject: CommentSubject;
    question: string;
  }): Promise<AskResult> {
    return this.#sendToGuideAgent(reviewId, drawnAt, async (record, guide) => {
      if (question.trim() === "") return { refused: "Type a question to ask first." };
      const { headSha } = record.header;
      const changeRequest = await this.#store.snapshot(record.id, headSha);
      if (changeRequest === null) return { refused: "What the forge said at this head is missing. Start the review again." };
      try {
        return { prompt: questionPrompt(record.ref, headSha, commentSubjectContext(changeRequest.files, guide, subject), question) };
      } catch (error) {
        return { refused: errorMessage(error) };
      }
    });
  }

  /**
   * Sends the prompt `promptFor` writes for the guide the panel shows, or keeps the reason it gives
   * not to. Sends only to an idle agent of a finished guide, since a prompt to a busy one would
   * interrupt it; otherwise says why not. `drawnAt` is the head of the guide the panel drew, refused
   * once Regenerate has moved the review off it.
   */
  async #sendToGuideAgent(
    reviewId: string,
    drawnAt: string,
    promptFor: (record: ReviewRecord, guide: LayeredGuide) => Promise<{ prompt: string } | { refused: string }>,
  ): Promise<AskResult> {
    let record: ReviewRecord;
    try {
      record = await this.#record(reviewId);
    } catch (error) {
      return notSent(null, unknownReview(error));
    }
    const { headSha } = record.header;
    if (drawnAt !== headSha) return notSent(null, regeneratedAway(drawnAt, headSha, "This question is about", "Ask from"));
    const running = this.#guides.running(record);
    if (running) return notSent(running.agentId, "The guide agent is still writing the guide. Ask once the guide is ready.");
    const shown = await this.#guides.shown(record);
    if (shown === null) {
      // A failed guide still has an agent, whose chat the panel can open.
      const stored = await this.#store.getGuide(record.id, headSha);
      return notSent(stored?.agentId ?? null, "There is no finished guide to ask about yet.");
    }
    const { agentId } = shown;

    const written = await promptFor(record, shown.guide);
    if ("refused" in written) return notSent(agentId, written.refused);

    const unavailable = await this.#unavailable(agentId, "Ask again once it has finished.", "no chat to ask in");
    if (unavailable !== null) return notSent(unavailable.gone ? null : agentId, unavailable.message);
    try {
      await this.#guideAgents.send(agentId, written.prompt);
    } catch (error) {
      // The agent got busy, or went, between the check and the send.
      if (error instanceof GuideAgentError) return notSent(agentId, error.message);
      throw error;
    }
    return { status: "sent", agentId };
  }

  /**
   * The hunks a subject of the review's current guide covers, parsed from what the forge said at the
   * guide's head: a node's, in the order it names its files, or what no node covers of a changed
   * file, which is what a Supporting or Unsorted entry shows: its whole diff, or the rest of it.
   */
  async nodeDiff({ reviewId, subject }: { reviewId: string; subject: GuideSubject }): Promise<NodeDiff> {
    const record = await this.#record(reviewId);
    const { headSha } = record.header;
    const stored = await this.#store.getGuide(record.id, headSha);
    if (stored?.status !== "ready" || stored.guide === null) throw new Error("The guide is not ready yet.");
    let covers: CoveredCode[] = [];
    if (subject.kind === "node") {
      const node = stored.guide.nodes.find((candidate) => candidate.id === subject.nodeId);
      if (node === undefined) throw new Error(`The guide has no concept "${subject.nodeId}". Reopen the panel.`);
      covers = node.covers;
    }
    const changeRequest = await this.#store.snapshot(record.id, headSha);
    if (changeRequest === null) throw new Error("What the forge said at this head is missing. Start the review again.");
    let files: FileDiff[];
    if (subject.kind === "node") {
      files = resolveCode(changeRequest.files, covers).files;
    } else {
      const entry = entryCode(changeRequest.files, stored.guide.nodes, subject.path);
      if (entry === null) throw new Error(`${subject.path} is not one of the change's files.`);
      files = [entry];
    }
    const highlighted = await this.#highlighter.highlight(`${record.id}:${headSha}`, files, changeRequest.files, {
      baseSha: changeRequest.baseSha,
      headSha,
      fileAt: (sha, path) => this.#workspaces.fileAt({ workspace: record.workspace, sha, path }),
    });
    return { headSha, files: highlighted };
  }

  /** The palettes the panel colours the diffs' syntax tokens with, from the syntax theme `theme` names. */
  async syntaxColors({ theme }: { theme: string }): Promise<SyntaxColors> {
    return syntaxColors(theme);
  }

  /** The syntax themes the setting offers. */
  async syntaxThemes(): Promise<{ themes: { id: string; label: string }[] }> {
    return { themes: syntaxThemes() };
  }

  /**
   * The reviewer's progress through the guide the panel shows: the one at the review's head, in its
   * workspace. Null while that guide is not ready, or is being generated again, which replaces the
   * one on disk and its marks with it.
   */
  async readingProgress({ reviewId }: { reviewId: string }): Promise<GuideProgress | null> {
    const record = await this.#store.get(reviewId);
    const shown = record === null ? null : await this.#guides.shown(record);
    if (record === null || shown === null) return null;
    return summariseProgress(shown.guide, shown.headSha, marksOf(shown, await this.#store.getProgress(record.id, shown.headSha)));
  }

  /**
   * Marks nodes, and Supporting or Unsorted entries, of the guide at `headSha` understood, or clears
   * their marks, and keeps the marks on disk under that head. A subject the guide lacks refuses the
   * whole write. Marks of one guide are written one at a time, so two toggles at once both land.
   */
  async setUnderstood({
    reviewId,
    headSha,
    subjects,
    understood,
  }: {
    reviewId: string;
    headSha: string;
    subjects: readonly GuideSubject[];
    understood: boolean;
  }): Promise<GuideProgress> {
    return this.#progressWrites(`${reviewId}@${headSha}`, () => this.#setUnderstood(reviewId, headSha, subjects, understood));
  }

  async #setUnderstood(reviewId: string, headSha: string, subjects: readonly GuideSubject[], understood: boolean): Promise<GuideProgress> {
    const record = await this.#record(reviewId);
    const stored = this.#guides.running(record, headSha) ? null : await this.#store.getGuide(record.id, headSha);
    if (stored === null || !isReady(stored)) throw new Error("There is no finished guide to mark progress in.");
    const { guide } = stored;
    for (const subject of subjects) {
      if (subject.kind === "node" && !guide.nodes.some((node) => node.id === subject.nodeId)) {
        throw new Error("That concept is not in the guide any more.");
      }
      if (subject.kind === "file" && !guide.supporting.some((entry) => entry.path === subject.path) && !guide.unsorted.includes(subject.path)) {
        throw new Error(`${subject.path} is not a Supporting or Unsorted file of the guide.`);
      }
    }

    const marks = marksOf(stored, await this.#store.getProgress(record.id, headSha));
    const apply = (list: readonly string[], values: readonly string[]) =>
      understood ? [...new Set([...list, ...values])] : list.filter((entry) => !values.includes(entry));
    const saved: ProgressRecord = {
      headSha,
      agentId: stored.agentId,
      nodes: apply(marks.nodes, subjects.flatMap((subject) => (subject.kind === "node" ? [subject.nodeId] : []))),
      files: apply(marks.files, subjects.flatMap((subject) => (subject.kind === "file" ? [subject.path] : []))),
      updatedAt: this.#now().toISOString(),
    };
    await this.#store.saveProgress(record.id, saved);
    return summariseProgress(guide, headSha, saved);
  }

  /**
   * The reviewer's drafts, read from the forge every time, with GitHub's general comments, each with the
   * part of the guide the panel shows it was written from: see `ReviewDrafts.list`.
   */
  async listDrafts({ reviewId }: { reviewId: string }): Promise<DraftList> {
    const record = await this.#record(reviewId);
    return this.#drafts.list(record, this.#forgeFor(record.ref));
  }

  /**
   * Saves a comment on the forge as a draft at once, on lines of the diff the panel drew at `headSha`,
   * linked to the node or overview `from` of that guide it was written from, with the passage `quote`
   * highlighted there: see `ReviewDrafts.create`.
   */
  async createDraft({
    reviewId,
    headSha,
    location,
    body,
    from = null,
    quote = null,
  }: {
    reviewId: string;
    headSha: string;
    location: DraftLocation;
    body: string;
    from?: CommentOrigin | null | undefined;
    quote?: string | null | undefined;
  }): Promise<LinkedDraft> {
    const record = await this.#record(reviewId);
    return this.#drafts.create(record, this.#forgeFor(record.ref), { drawnAt: headSha, location, body, from, quote });
  }

  async updateDraft({ reviewId, draftId, body }: { reviewId: string; draftId: string; body: string }): Promise<null> {
    const record = await this.#record(reviewId);
    await this.#drafts.update(record, this.#forgeFor(record.ref), draftId, body);
    return null;
  }

  async deleteDraft({ reviewId, draftId }: { reviewId: string; draftId: string }): Promise<null> {
    const record = await this.#record(reviewId);
    await this.#drafts.delete(record, this.#forgeFor(record.ref), draftId);
    return null;
  }

  /**
   * "Suggest wording": has the review's guide agent word a comment on `subject` from what the reviewer
   * typed, as a background job the panel follows through `suggestion`, since the agent may take longer
   * than an RPC may. Asks only an idle agent of a finished guide, one request at a time; otherwise says
   * why not. The text goes back to the comment box; nothing is saved or posted. As for `createDraft`,
   * the subject's lines are those of the guide the panel drew at `headSha`, and one from a guide
   * Regenerate has replaced is refused rather than worded from whatever the new head numbers the same.
   */
  async suggestWording({
    reviewId,
    headSha: drawnAt,
    subject,
    prompt,
  }: {
    reviewId: string;
    headSha: string;
    subject: CommentSubject;
    prompt: string;
  }): Promise<Suggestion> {
    let record: ReviewRecord;
    try {
      record = await this.#record(reviewId);
    } catch (error) {
      return notSuggested(unknownReview(error));
    }
    const { headSha } = record.header;
    if (drawnAt !== headSha) return notSuggested(regeneratedAway(drawnAt, headSha));
    if (this.#guides.running(record)) return notSuggested("The guide agent is still writing the guide. Try again once the guide is ready.");
    const shown = await this.#guides.shown(record);
    if (shown === null) return notSuggested("There is no finished guide yet, so there is no guide agent to suggest wording.");
    const { agentId } = shown;

    const changeRequest = await this.#store.snapshot(record.id, headSha);
    if (changeRequest === null) return notSuggested("What the forge said at this head is missing. Start the review again.");
    let context: CommentSubjectContext;
    try {
      context = commentSubjectContext(changeRequest.files, shown.guide, subject);
    } catch (error) {
      return notSuggested(errorMessage(error));
    }

    const again = "Try again once it has finished.";
    if ([...this.#suggestions.values()].some((job) => job.agentId === agentId && job.state.status === "running")) {
      return notSuggested(`${BUSY} ${again}`);
    }
    const unavailable = await this.#unavailable(agentId, again, "no one to suggest wording");
    if (unavailable !== null) return notSuggested(unavailable.message);

    const suggestionId = randomUUID();
    const job: SuggestionJob = { agentId, state: { status: "running", suggestionId }, done: Promise.resolve() };
    this.#suggestions.set(suggestionId, job);
    job.done = runStructured(this.#guideAgents, agentId, wordingPrompt(record.ref, headSha, context, prompt), WordingSchema)
      .then(({ body }) => {
        const text = body.trim();
        job.state = text === "" ? notSuggested("The guide agent suggested no wording. Try again.") : { status: "ready", body: text };
      })
      .catch((error: unknown) => {
        if (!(error instanceof GuideAgentError)) this.#log(`Suggesting wording for ${record.header.url} failed: ${errorMessage(error)}`);
        job.state = notSuggested(errorMessage(error));
      });
    return job.state;
  }

  /** Where a suggestion has got to. A finished one is handed out once, then forgotten. */
  async suggestion({ suggestionId }: { suggestionId: string }): Promise<Suggestion> {
    const job = this.#suggestions.get(suggestionId);
    if (job === undefined) return notSuggested("The suggestion was lost, most likely to a plugin restart. Try again.");
    if (job.state.status !== "running") this.#suggestions.delete(suggestionId);
    return job.state;
  }

  /**
   * The Finish review step: the review body as it is kept until submit, and the verdicts on offer, from
   * the head as the forge has it now.
   */
  async finish({ reviewId }: { reviewId: string }): Promise<FinishView> {
    const record = await this.#record(reviewId);
    const [head, body] = await Promise.all([this.checkHead({ reviewId }), this.#drafts.ownBody(record)]);
    return { body, verdicts: verdictsFor(record, head), head };
  }

  async saveReviewBody({ reviewId, body }: { reviewId: string; body: string }): Promise<null> {
    const record = await this.#record(reviewId);
    await this.#drafts.saveOwnBody(record, body.trim());
    return null;
  }

  /**
   * Publishes the drafts and the body with the verdict. The head is asked of the forge again here,
   * whatever the panel last heard, so a verdict never goes out on code the reviewer was not warned of.
   * The forge's steps are reported one by one, since a later one can fail after an earlier landed.
   */
  async submit({
    reviewId,
    headSha,
    forgeHeadSha,
    verdict,
    body,
  }: {
    reviewId: string;
    headSha: string;
    forgeHeadSha: string | null;
    verdict: Verdict;
    body: string;
  }): Promise<SubmitResult> {
    const record = await this.#record(reviewId);
    const forge = this.#forgeFor(record.ref);
    const text = body.trim();
    await this.#drafts.saveOwnBody(record, text);
    const head = await this.checkHead({ reviewId });
    const verdicts = verdictsFor(record, head);
    if (headSha !== record.header.headSha) {
      return { status: "refused", message: regeneratedAway(headSha, record.header.headSha, "This review is of", "Finish it from"), verdicts };
    }
    const option = verdicts.find((candidate) => candidate.verdict === verdict);
    if (!option?.allowed) return { status: "refused", message: option?.reason ?? "That verdict is not on offer.", verdicts };
    if (verdict !== "comment" && warnedOfAnotherHead(head, forgeHeadSha)) {
      const noun = record.ref.forge === "gitlab" ? "MR" : "PR";
      return { status: "refused", message: `The ${noun} changed again since Finish review read it. Check the warning and submit again.`, verdicts };
    }

    const outcome = await this.#drafts.submit(record, forge, { verdict, body: text, approveHeadSha: head.forgeHeadSha });
    if (outcome.published) {
      const latest = (await this.#store.get(reviewId)) ?? record;
      await this.#store.update({ ...latest, submittedHeadSha: record.header.headSha });
    }
    for (const step of outcome.steps) {
      if (step.status === "failed") this.#log(`Submitting ${record.ref.url}: "${step.label}" failed: ${step.message}`);
    }
    const done = outcome.steps.filter((step) => step.status === "done").length;
    const status = done === outcome.steps.length ? "submitted" : done === 0 ? "failed" : "partial";
    return { status, published: outcome.published, steps: outcome.steps };
  }

  /** Throws the pending review away with its drafts and body; the panel asks the reviewer first. */
  async discard({ reviewId }: { reviewId: string }): Promise<null> {
    const record = await this.#record(reviewId);
    await this.#drafts.discard(record, this.#forgeFor(record.ref));
    return null;
  }

  /** For the `workspace.archived` hook: a review's workspace ending ends its guide agents. */
  async workspaceArchived({ workspaceId }: { workspaceId: string }): Promise<void> {
    const record = await this.#store.findByWorkspace(workspaceId);
    if (record !== null) await this.#guides.endAll(record.id, workspaceId);
  }

  /** Resolves once no background job is running, including the ones a finishing job started. */
  async settled(): Promise<void> {
    const jobs = () => [...[...this.#branchStarts.values()].map((job) => job.done), ...this.#preparation.pending()];
    for (;;) {
      const running = [...jobs(), ...this.#guides.pending().done, ...[...this.#suggestions.values()].map((job) => job.done)];
      await Promise.all(running);
      if (this.#guides.pending().idle && jobs().every((done) => running.includes(done))) return;
    }
  }

  /**
   * The review `reviewId` names. One this daemon has no record of throws an `UnknownReviewError`, which
   * the RPCs that answer rather than throw turn into their answer through `unknownReview`.
   */
  async #record(reviewId: string): Promise<ReviewRecord> {
    const record = await this.#store.get(reviewId);
    if (record === null) throw new UnknownReviewError();
    return record;
  }

  /** The forge a recorded review was read from. */
  #forgeFor(ref: ChangeRequestRef): Forge {
    const forge = this.#forges.find((candidate) => candidate.kind === ref.forge);
    if (forge === undefined) throw new Error(`No ${ref.forge} forge is set up to read ${ref.url}.`);
    return forge;
  }

  /**
   * Why the guide agent cannot take a prompt now, or null when it is idle, since a prompt to a busy
   * one would interrupt it. `again` says when to try again; `without` what a gone agent leaves none of.
   */
  async #unavailable(agentId: string, again: string, without: string): Promise<{ gone: boolean; message: string } | null> {
    switch (await this.#guideAgents.status(agentId)) {
      case "busy":
        return { gone: false, message: `${BUSY} ${again}` };
      case "gone":
        return { gone: true, message: `The guide agent is gone: it was archived or closed, so there is ${without}.` };
      case "idle":
        return null;
    }
  }

  async #match(url: string): Promise<{ forge: Forge; ref: ChangeRequestRef } | null> {
    for (const forge of this.#forges) {
      const ref = await forge.matchUrl(url);
      if (ref !== null) return { forge, ref };
    }
    return null;
  }

  /** Finds the change request the workspace's branch is the source of, and starts it when there is one. */
  async #findBranch(workspaceId: string, job: BranchJob): Promise<void> {
    const checkout = await this.#workspaces.inspect(workspaceId);
    if (checkout === null) {
      job.state = { status: "failed", message: "This workspace is not open any more." };
      return;
    }
    const { branch, repository } = checkout;
    if (branch === null) {
      job.state = { status: "none", message: "This workspace is not on a branch, so no PR or MR comes from it." };
      return;
    }
    if (repository === null) {
      job.state = { status: "none", message: "This workspace's repository has no origin on GitHub or GitLab to find a PR or MR on." };
      return;
    }

    for (const forge of this.#forges) {
      let found: BranchChangeRequest[] | null;
      try {
        found = await forge.findByBranch(repository, branch);
      } catch (error) {
        if (!(error instanceof ForgeError)) throw error;
        job.state = { status: "failed", message: error.message };
        return;
      }
      if (found === null) continue;

      const local: LocalCheckout = { ...checkout, branch, repository };
      if (found.length === 0) {
        const kind = forge.kind === "gitlab" ? "merge request" : "pull request";
        job.state = { status: "none", message: `No open ${kind} in ${repository.project} comes from ${branch}.` };
      } else if (found.length === 1) {
        job.state = { status: "started", reviewId: this.#preparation.begin(forge, found[0]!.ref, ownWorkspace(local)) };
      } else {
        job.state = { status: "choose", checkout: local, forge, candidates: found };
      }
      return;
    }
    job.state = { status: "none", message: `${repository.host} is neither GitHub nor a GitLab glab is logged in to.` };
  }

  /** Whether the branch guiding is still under way: finding its change request, or preparing its review. */
  async #branchRunning(job: BranchJob): Promise<boolean> {
    if (job.state.status === "finding") return true;
    if (job.state.status !== "started") return false;
    return !isFinished((await this.startProgress({ reviewId: job.state.reviewId })).phase);
  }

  async #branchView(job: BranchJob): Promise<BranchStart> {
    const { state } = job;
    switch (state.status) {
      case "finding":
      case "none":
      case "failed":
        return state;
      case "choose":
        return {
          status: "choose",
          branch: state.checkout.branch,
          candidates: state.candidates.map(({ ref, title, author }) => ({ forge: ref.forge, url: ref.url, number: ref.number, title, author })),
        };
      case "started": {
        const note = this.#preparation.noteOf(state.reviewId) ?? (await this.#store.get(state.reviewId))?.note ?? null;
        return { status: "started", reviewId: state.reviewId, progress: await this.startProgress({ reviewId: state.reviewId }), note };
      }
    }
  }
}

/** A workspace on a branch as the one to attach a guide to, fast-forwarding it first. */
function ownWorkspace(checkout: LocalCheckout): ReviewWorkspace {
  return { ...checkout.workspace, branch: checkout.branch };
}

/** The verdicts on offer on `record`'s change request, with its state as the head check found it where it could. */
function verdictsFor(record: ReviewRecord, head: HeadCheck): VerdictOption[] {
  return verdictOptions({
    forge: record.ref.forge,
    own: viewerIsAuthor(record),
    state: head.state ?? record.header.state,
    head,
  });
}

function viewerIsAuthor(record: ReviewRecord): boolean {
  // Both forges take a username in any case.
  return record.viewer.login.toLowerCase() === record.header.author.toLowerCase();
}

/** A screenshot is well within it, and every image is one RPC message, base64 and all. */
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

const BUSY = "The guide agent is busy with another answer.";

/** A review this daemon has no record of any more. */
class UnknownReviewError extends Error {
  constructor() {
    super("This review is not known here any more. Start it again.");
  }
}

/** The message of an `UnknownReviewError`, for an RPC that answers rather than throws; anything else is thrown on. */
function unknownReview(error: unknown): string {
  if (error instanceof UnknownReviewError) return error.message;
  throw error;
}

function notSuggested(message: string): Suggestion {
  return { status: "failed", message };
}

function notSent(agentId: string | null, message: string): AskResult {
  return { status: "not-sent", agentId, message };
}
