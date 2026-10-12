import type { DiffLine } from "../../shared/diff.ts";
import type { Draft } from "../../shared/drafts.ts";
import type { ListedHost } from "../../shared/inbox.ts";
import type { SubmitStep, Verdict } from "../../shared/submit.ts";

/**
 * What the review service asks of a forge. Each forge has one adapter implementing it over its CLI
 * (`gh`, `glab`) through a command runner, so a test replays recorded output through a fake runner
 * and the service is tested against a fake of this port.
 *
 * Grows with the tickets that need it.
 */
export interface Forge {
  readonly kind: ForgeKind;
  /** How the service describes a URL this forge takes, in a sentence that rejects one it does not. */
  readonly urlHint: string;
  /**
   * The change request a pasted URL names, or null when the URL is not one of this forge's. Throws a
   * `ForgeError` for a URL that is this forge's but cannot be read from here, like one on a GitLab
   * host `glab` is not logged in to.
   */
  matchUrl(url: string): Promise<ChangeRequestRef | null>;
  /**
   * The open change requests in `repository` whose source branch is `branch`, or null when the
   * repository is not on this forge's host. Throws a `ForgeError` for one that is but cannot be read.
   */
  findByBranch(repository: RepositoryRef, branch: string): Promise<BranchChangeRequest[] | null>;
  fetchChangeRequest(ref: ChangeRequestRef): Promise<ChangeRequest>;
  /**
   * Where the change request's head is now, and its state: one cheap read, for noticing a push
   * since the guide was written without reading the whole change request again.
   */
  fetchHead(ref: ChangeRequestRef): Promise<ChangeRequestHead>;
  /**
   * The file at `url`, an absolute URL from the change request's description, base64-encoded: read
   * with the CLI's login, since a private repository's attachments need one. Null when `url` is not
   * where this forge keeps attachments, which the plugin then leaves for the browser to open.
   */
  fetchAttachment(ref: ChangeRequestRef, url: string, maxBytes: number): Promise<string | null>;
  /**
   * How the change request's commits now stand against `sha`, an earlier head: read from its latest
   * commits, so `sha` gone from a list that is complete means the branch was rewritten. Null when the
   * list is cut off before `sha` turns up, so it cannot tell.
   */
  commitsSince(ref: ChangeRequestRef, sha: string): Promise<CommitsSince | null>;
  /**
   * Every change request each of `shas`, commits of the change request `ref`, belongs to, `ref`'s own
   * included, as the forge links them: by SHA, so a commit rebased onto another branch is a new one.
   */
  commitChangeRequests(ref: ChangeRequestRef, shas: readonly string[]): Promise<Map<string, CommitChangeRequest[]>>;
  /**
   * The paths of the files `to` changes since `from`, an ancestor of it in `ref`'s repository, a
   * renamed file's both; null when the forge would list only some of them.
   */
  changedPaths(ref: ChangeRequestRef, from: string, to: string): Promise<string[] | null>;
  /** Who the CLI is logged in as on the change request's host. */
  currentUser(ref: ChangeRequestRef): Promise<ForgeUser>;
  /** Clones the change request's repository into `directory`, which must not exist yet. */
  cloneRepository(ref: ChangeRequestRef, directory: string): Promise<void>;

  /**
   * The current user's unpublished comments on the change request, whether this plugin or the
   * forge's web UI started them. Only the reviewer's own: both forges keep drafts private.
   */
  listDrafts(ref: ChangeRequestRef): Promise<Draft[]>;
  /**
   * Saves a comment as a draft on the forge at once, unpublished: on GitHub a thread on the viewer's
   * pending review, found or started; on GitLab a draft note. Returns the draft as the forge has it.
   */
  createDraft(target: DraftTarget, draft: NewDraft): Promise<Draft>;
  /** Replaces a draft's text, leaving where it sits as it is. */
  updateDraft(ref: ChangeRequestRef, draftId: string, body: string): Promise<void>;
  deleteDraft(ref: ChangeRequestRef, draftId: string): Promise<void>;

  /**
   * Whether `createDraft` takes a `general` anchor: GitLab's MR-level draft note. Where it does not
   * (GitHub), the service keeps such a comment until submit and posts it then with `postComment`.
   */
  readonly takesGeneralDrafts: boolean;
  /** Publishes a comment on the change request as a whole at once, outside any review. */
  postComment(ref: ChangeRequestRef, body: string): Promise<void>;
  /**
   * Publishes a comment on the change request as a whole that asks the author to act: a thread on
   * GitLab, which the author resolves and which can hold merging back until they do. GitHub has no
   * thread on a PR as a whole, so there it is a comment like `postComment`'s.
   */
  startDiscussion(ref: ChangeRequestRef, body: string): Promise<void>;
  /**
   * Publishes the reviewer's drafts and `body` with the verdict, in as many calls as the forge takes,
   * and says how each went rather than throwing at the first to fail, so the panel can say what
   * landed. A review with nothing pending yet is started on `target`'s head first.
   */
  submitReview(target: DraftTarget, submission: ReviewSubmission): Promise<SubmitOutcome>;
  /** Throws the reviewer's pending review away with every draft on it; nothing to discard is not a failure. */
  discardReview(ref: ChangeRequestRef): Promise<void>;

  /**
   * The open change requests the current user is a reviewer of, and those they authored, on every host of this forge the CLI is logged in to.
   * A host that cannot be listed comes back with its error rather than throwing.
   */
  listChangeRequests(): Promise<ListedHost[]>;
}

/**
 * `approveHeadSha` is the head the forge had when the submit checked it, which an approval on GitLab
 * names so a push after that check is refused; null when it could not be checked, so it names none.
 */
export type ReviewSubmission = { verdict: Verdict; body: string; approveHeadSha: string | null };

/**
 * How a submit went, step by step. `published` is whether the drafts and the body went out, so
 * nothing is pending any more, whatever became of the verdict after.
 */
export type SubmitOutcome = { published: boolean; steps: SubmitStep[] };

/**
 * The change request a draft is written against, at the head the panel's diff was read at: a
 * GitHub pending review is started on that commit, and a GitLab position names all three SHAs.
 */
export type DraftTarget = Pick<ChangeRequest, "ref" | "baseSha" | "startSha" | "headSha">;

export type NewDraft = { anchor: DraftAnchor; body: string };

/**
 * A line of a file's diff, with everything either forge anchors a comment on it by: its kind and
 * numbers for GitHub's side and line, and GitLab's running counters for its `line_code`.
 */
export type AnchorLine = Pick<DiffLine, "kind" | "oldLine" | "newLine" | "oldPos" | "newPos">;

/** The file a draft is on; GitLab names both paths of a renamed file. */
export type AnchorFile = { path: string; previousPath: string | null };

/**
 * Where a new draft goes, resolved against the diff by the service so an adapter only translates:
 * a line, a range of one hunk's lines in the diff's order, the file as a whole, or the change as a
 * whole (`general`). The forge-neutral form a draft comes back in is `DraftLocation` in `shared/drafts.ts`.
 *
 * Only GitLab takes a `general` draft, as a draft note without a position. On GitHub such a comment
 * is kept by the service and posted as a comment of its own at submit.
 */
export type DraftAnchor =
  | (AnchorFile & { kind: "line"; line: AnchorLine })
  | (AnchorFile & { kind: "range"; start: AnchorLine; end: AnchorLine })
  | (AnchorFile & { kind: "file" })
  | { kind: "general" };

export type ForgeKind = "github" | "gitlab";

/** A change request as its URL names it: enough to address it, before anything is read. */
export type ChangeRequestRef = {
  forge: ForgeKind;
  /** The web host, lower-cased: `github.com`. */
  host: string;
  /** The repository path on that host: `owner/repo`, or `group/sub/project` on GitLab. */
  project: string;
  /** The PR's number, or the MR's IID: the number in its URL, not GitLab's global ID. */
  number: number;
  /** The canonical web URL, whatever suffix the pasted one had. */
  url: string;
};

/** A repository as its git remote names it: the web host and the project path on it. */
export type RepositoryRef = { host: string; project: string };

/** An open change request found by its source branch: enough to tell several apart. */
export type BranchChangeRequest = {
  ref: ChangeRequestRef;
  title: string;
  author: string;
  headSha: string;
};

/**
 * The ref a change request's head can be fetched from in its target repository, fork or not:
 * GitHub's `refs/pull/<n>/head` and GitLab's `refs/merge-requests/<iid>/head`.
 */
export function changeRequestHeadRef(ref: ChangeRequestRef): string {
  return ref.forge === "github" ? `refs/pull/${ref.number}/head` : `refs/merge-requests/${ref.number}/head`;
}

export type ChangeRequestState = "open" | "closed" | "merged";

/**
 * A change request's head as the forge has it now. `headSha` is the head `fetchChangeRequest` would
 * read the diff at, so a guide at another head is one a new read would write differently.
 */
export type ChangeRequestHead = {
  headSha: string;
  state: ChangeRequestState;
  /** The description as it reads now, which the author can edit without pushing. */
  description: string;
};

export type CommitsSince = { kind: "after"; count: number } | { kind: "rewritten" };

/** Where `sha` sits in `newestFirst`, a change request's latest commits, which `complete` says are all of them. */
export function commitsSinceIn(newestFirst: readonly string[], sha: string, complete: boolean): CommitsSince | null {
  const index = newestFirst.indexOf(sha);
  if (index !== -1) return { kind: "after", count: index };
  return complete ? { kind: "rewritten" } : null;
}

export type ForgeUser = {
  login: string;
  name: string | null;
};

export type ChangedFileStatus = "added" | "removed" | "modified" | "renamed" | "copied" | "changed" | "unchanged";

export type ChangedFile = {
  path: string;
  /** Where a renamed or copied file came from. */
  previousPath: string | null;
  status: ChangedFileStatus;
  additions: number;
  deletions: number;
  /**
   * The file's unified diff from its first `@@`, without the `diff --git` header. Null when the forge
   * gave none, which it does for binary files and for diffs too large to show.
   */
  patch: string | null;
};

export type ChangeRequestCommit = {
  sha: string;
  headline: string;
  body: string;
  author: string;
  authoredAt: string;
  /** The first parent first, as git orders them; a merge has more than one. */
  parents: string[];
};

/** A change request a commit belongs to, as `commitChangeRequests` names it. */
export type CommitChangeRequest = {
  number: number;
  url: string;
  title: string;
  state: ChangeRequestState;
  sourceBranch: string;
  targetBranch: string;
};

export type LinkedIssue = {
  number: number;
  url: string;
  title: string;
  body: string;
  state: string;
};

/** Everything the guide is built from, read at one head SHA. */
export type ChangeRequest = {
  ref: ChangeRequestRef;
  title: string;
  description: string;
  author: ForgeUser;
  state: ChangeRequestState;
  isDraft: boolean;
  baseBranch: string;
  headBranch: string;
  /** Where the diff is taken from: the merge base on GitLab, the base branch's tip on GitHub. */
  baseSha: string;
  /**
   * The base branch's tip when the diff was taken, which a GitLab draft's position names beside the
   * base and head SHAs. The same as `baseSha` on GitHub.
   */
  startSha: string;
  headSha: string;
  additions: number;
  deletions: number;
  commits: ChangeRequestCommit[];
  linkedIssues: LinkedIssue[];
  files: ChangedFile[];
};

/** A forge call that failed, with a message fit to show the reviewer as it is. */
export class ForgeError extends Error {
  override name = "ForgeError";
}
