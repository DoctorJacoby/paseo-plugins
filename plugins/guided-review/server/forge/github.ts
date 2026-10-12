import { z } from "zod";
import type { CommandRunner } from "../command-runner.ts";
import { oneAtATimePer } from "../one-at-a-time.ts";
import { createCli } from "./cli.ts";
import type { Draft, DraftLocation } from "../../shared/drafts.ts";
import type { AuthoredChangeRequest, CiState, ListedChangeRequest, ListedHost, ReviewerState, ReviewRequest } from "../../shared/inbox.ts";
import type { Verdict } from "../../shared/submit.ts";
import { CLONE_TIMEOUT_MS, MAX_BRANCH_CHANGE_REQUESTS, MAX_COMMITS, MAX_LINKED_ISSUES, latestOf, reviewStatusOf, unlistedHost, userOf } from "./common.ts";
import { SubmitSteps } from "./submit-steps.ts";
import {
  commitsSinceIn,
  ForgeError,
  type AnchorLine,
  type BranchChangeRequest,
  type ChangedFileStatus,
  type ChangeRequest,
  type ChangeRequestHead,
  type ChangeRequestRef,
  type ChangeRequestState,
  type DraftAnchor,
  type DraftTarget,
  type Forge,
  type ForgeUser,
} from "./port.ts";

export const GITHUB_HOST = "github.com";

/** No prompts, no update nags and no colour codes: the output is parsed, not read. */
const GH_ENV = { GH_PROMPT_DISABLED: "1", GH_NO_UPDATE_NOTIFIER: "1", NO_COLOR: "1" };

/**
 * One query for the metadata, the commits and the linked issues. `closingIssuesReferences` is the
 * only place GitHub gives linked issues their titles and bodies in the same round trip.
 */
export const PULL_REQUEST_QUERY = `query GuidedReviewPullRequest($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      number url title body state isDraft
      author { login ... on User { name } }
      baseRefName baseRefOid headRefName headRefOid
      additions deletions changedFiles
      commits(first: ${MAX_COMMITS}) { totalCount nodes { commit { oid messageHeadline messageBody authoredDate author { name user { login } } parents(first: 2) { nodes { oid } } } } }
      closingIssuesReferences(first: ${MAX_LINKED_ISSUES}) { nodes { number url title body state } }
    }
  }
}`;

const PullRequestResponse = z.object({
  data: z.object({
    repository: z
      .object({
        pullRequest: z
          .object({
            title: z.string(),
            body: z.string(),
            state: z.enum(["OPEN", "CLOSED", "MERGED"]),
            isDraft: z.boolean(),
            author: z.object({ login: z.string(), name: z.string().nullish() }).nullable(),
            baseRefName: z.string(),
            baseRefOid: z.string(),
            headRefName: z.string(),
            headRefOid: z.string(),
            additions: z.number(),
            deletions: z.number(),
            commits: z.object({
              nodes: z.array(
                z.object({
                  commit: z.object({
                    oid: z.string(),
                    messageHeadline: z.string(),
                    messageBody: z.string(),
                    authoredDate: z.string(),
                    author: z.object({ name: z.string().nullish(), user: z.object({ login: z.string() }).nullish() }).nullish(),
                    parents: z.object({ nodes: z.array(z.object({ oid: z.string() })) }),
                  }),
                }),
              ),
            }),
            closingIssuesReferences: z.object({
              nodes: z.array(
                z.object({ number: z.number(), url: z.string(), title: z.string(), body: z.string(), state: z.string() }),
              ),
            }),
          })
          .nullable(),
      })
      .nullable(),
  }),
});

/** Only where the head is and whether the PR is still open, for noticing a push without reading the PR again. */
export const PULL_REQUEST_HEAD_QUERY = `query GuidedReviewPullRequestHead($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) { headRefOid state body }
  }
}`;

/** GitHub lists at most 250 commits on a pull request; the latest 100 are as far back as a count goes. */
export const PULL_REQUEST_COMMITS_QUERY = `query GuidedReviewPullRequestCommits($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) { commits(last: 100) { totalCount nodes { commit { oid } } } }
  }
}`;

const PullRequestCommitsResponse = z.object({
  data: z.object({
    repository: z
      .object({
        pullRequest: z
          .object({ commits: z.object({ totalCount: z.number(), nodes: z.array(z.object({ commit: z.object({ oid: z.string() }) })) }) })
          .nullable(),
      })
      .nullable(),
  }),
});

/**
 * The pull requests each of the PR's commits belongs to. GitHub links a commit on the default branch
 * only to the merged PR that brought it there, and any other to every open or merged PR that has it.
 */
export const COMMIT_PULL_REQUESTS_QUERY = `query GuidedReviewCommitPullRequests($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      commits(first: ${MAX_COMMITS}) { nodes { commit { oid associatedPullRequests(first: 10) { nodes { number url title state headRefName baseRefName } } } } }
    }
  }
}`;

const CommitPullRequestsResponse = z.object({
  data: z.object({
    repository: z
      .object({
        pullRequest: z
          .object({
            commits: z.object({
              nodes: z.array(
                z.object({
                  commit: z.object({
                    oid: z.string(),
                    associatedPullRequests: z.object({
                      nodes: z.array(
                        z.object({
                          number: z.number(),
                          url: z.string(),
                          title: z.string(),
                          state: z.enum(["OPEN", "CLOSED", "MERGED"]),
                          headRefName: z.string(),
                          baseRefName: z.string(),
                        }),
                      ),
                    }),
                  }),
                }),
              ),
            }),
          })
          .nullable(),
      })
      .nullable(),
  }),
});

/** GitHub lists at most this many of a comparison's files, and no more on any page. */
export const MAX_COMPARE_FILES = 300;

const CompareResponse = z.object({
  files: z.array(z.object({ filename: z.string(), previous_filename: z.string().nullish() })),
});

const PullRequestHeadResponse = z.object({
  data: z.object({
    repository: z
      .object({
        pullRequest: z.object({ headRefOid: z.string(), state: z.enum(["OPEN", "CLOSED", "MERGED"]), body: z.string() }).nullable(),
      })
      .nullable(),
  }),
});

const FilesResponse = z.array(
  z.object({
    filename: z.string(),
    previous_filename: z.string().optional(),
    status: z.enum(["added", "removed", "modified", "renamed", "copied", "changed", "unchanged"]),
    additions: z.number(),
    deletions: z.number(),
    patch: z.string().optional(),
  }),
);

const UserResponse = z.object({ login: z.string(), name: z.string().nullish() });

const BranchPullRequestsResponse = z.array(
  z.object({
    number: z.number(),
    url: z.string(),
    title: z.string(),
    author: z.object({ login: z.string() }).nullable(),
    headRefOid: z.string(),
  }),
);

/**
 * A pending review is visible only to its author and GitHub allows one per user and PR, so the
 * first pending review is the viewer's own, whether this plugin or github.com started it.
 */
export const PENDING_REVIEW_QUERY = `query GuidedReviewPendingReview($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      id
      reviews(states: PENDING, first: 1) { nodes { id viewerDidAuthor } }
    }
  }
}`;

/** No `event`, so the review stays pending: nothing is published until it is submitted. */
export const START_REVIEW_MUTATION = `mutation GuidedReviewStartReview($pullRequestId: ID!, $commitOID: GitObjectID!) {
  addPullRequestReview(input: { pullRequestId: $pullRequestId, commitOID: $commitOID }) {
    pullRequestReview { id }
  }
}`;

/** What a draft's location is read from: a comment carries no side, only its thread does. */
const THREAD_FIELDS = "path line originalLine startLine originalStartLine diffSide startDiffSide subjectType";

export const ADD_THREAD_MUTATION = `mutation GuidedReviewAddThread($input: AddPullRequestReviewThreadInput!) {
  addPullRequestReviewThread(input: $input) {
    thread { ${THREAD_FIELDS} comments(first: 1) { nodes { id body } } }
  }
}`;

export const UPDATE_COMMENT_MUTATION = `mutation GuidedReviewUpdateDraft($id: ID!, $body: String!) {
  updatePullRequestReviewComment(input: { pullRequestReviewCommentId: $id, body: $body }) {
    pullRequestReviewComment { id }
  }
}`;

export const DELETE_COMMENT_MUTATION = `mutation GuidedReviewDeleteDraft($id: ID!) {
  deletePullRequestReviewComment(input: { id: $id }) {
    pullRequestReviewComment { id }
  }
}`;

/** Threads are paged through; a thread's pending comments are the viewer's drafts in it, replies included. */
const MAX_THREADS = 100;
const MAX_THREAD_COMMENTS = 100;

export const DRAFTS_QUERY = `query GuidedReviewDrafts($owner: String!, $name: String!, $number: Int!, $after: String) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      reviews(states: PENDING, first: 1) { nodes { id viewerDidAuthor } }
      reviewThreads(first: ${MAX_THREADS}, after: $after) {
        pageInfo { hasNextPage endCursor }
        nodes { ${THREAD_FIELDS} comments(first: ${MAX_THREAD_COMMENTS}) { nodes { id body pullRequestReview { id } } } }
      }
    }
  }
}`;

const PendingReviews = z.object({ nodes: z.array(z.object({ id: z.string(), viewerDidAuthor: z.boolean() })) });

const PendingReviewResponse = z.object({
  data: z.object({
    repository: z.object({ pullRequest: z.object({ id: z.string(), reviews: PendingReviews }).nullable() }).nullable(),
  }),
});

const DiffSide = z.enum(["LEFT", "RIGHT"]);

const Thread = z.object({
  path: z.string(),
  line: z.number().nullable(),
  originalLine: z.number().nullable(),
  startLine: z.number().nullable(),
  originalStartLine: z.number().nullable(),
  diffSide: DiffSide,
  startDiffSide: DiffSide.nullable(),
  subjectType: z.enum(["LINE", "FILE"]).nullish(),
});

const StartReviewResponse = z.object({
  data: z.object({ addPullRequestReview: z.object({ pullRequestReview: z.object({ id: z.string() }) }) }),
});

const AddThreadResponse = z.object({
  data: z.object({
    addPullRequestReviewThread: z.object({
      thread: Thread.extend({ comments: z.object({ nodes: z.array(z.object({ id: z.string(), body: z.string() })) }) }).nullable(),
    }),
  }),
});

const DraftsResponse = z.object({
  data: z.object({
    repository: z
      .object({
        pullRequest: z
          .object({
            reviews: PendingReviews,
            reviewThreads: z.object({
              pageInfo: z.object({ hasNextPage: z.boolean(), endCursor: z.string().nullable() }),
              nodes: z.array(
                Thread.extend({
                  comments: z.object({
                    nodes: z.array(
                      z.object({ id: z.string(), body: z.string(), pullRequestReview: z.object({ id: z.string() }).nullable() }),
                    ),
                  }),
                }),
              ),
            }),
          })
          .nullable(),
      })
      .nullable(),
  }),
});

/** Publishes the pending review, every comment on it included, with its body and verdict. */
export const SUBMIT_REVIEW_MUTATION = `mutation GuidedReviewSubmit($id: ID!, $event: PullRequestReviewEvent!, $body: String!) {
  submitPullRequestReview(input: { pullRequestReviewId: $id, event: $event, body: $body }) {
    pullRequestReview { id state }
  }
}`;

/** Deletes the pending review, and with it every comment on it. */
export const DELETE_REVIEW_MUTATION = `mutation GuidedReviewDiscard($id: ID!) {
  deletePullRequestReview(input: { pullRequestReviewId: $id }) {
    pullRequestReview { id }
  }
}`;

const EVENTS: Record<Verdict, "APPROVE" | "REQUEST_CHANGES" | "COMMENT"> = {
  approve: "APPROVE",
  "request-changes": "REQUEST_CHANGES",
  comment: "COMMENT",
};

const SUBMIT_LABELS: Record<Verdict, string> = {
  approve: "Publish the review and approve",
  "request-changes": "Publish the review and request changes",
  comment: "Publish the review as a comment",
};

/**
 * GitHub drops a review request once the reviewer reviews, so what they are a reviewer of is two searches: the requests outstanding, team requests included, and the ones they answered.
 * What the viewer authored is a third search.
 * Pages are kept at half a GraphQL page, because a full one of these timed out as a 502.
 * `reviewed-by` also finds reviews nobody asked for, so `wasAskedToReview` keeps only those asked of the viewer.
 */
export const REVIEW_SEARCHES = {
  requested: "is:pr is:open review-requested:@me archived:false",
  reviewed: "is:pr is:open reviewed-by:@me -author:@me -review-requested:@me archived:false",
  authored: "is:pr is:open author:@me archived:false",
} as const;
const REVIEW_SEARCH_SIZE = 50;
const REVIEW_REQUEST_EVENTS = 20;
/** More reviewers, or dismissals, than one PR gathers. */
const AUTHORED_REVIEWERS = 20;

/**
 * What every listed PR is read with.
 * A pending review is visible only to its author, so the first one is the viewer's, and its comments are their drafts.
 * A PR author can be a deleted account, which GitHub gives as null.
 */
const LISTED_PULL_REQUEST_FIELDS = `number url title isDraft createdAt updatedAt headRefOid additions deletions changedFiles
        author { login }
        statusCheckRollup { state }
        reviews(states: PENDING, first: 1) { nodes { viewerDidAuthor comments { totalCount } } }`;

export const REVIEW_SEARCH_QUERY = `query GuidedReviewInbox($query: String!) {
  viewer { login }
  search(type: ISSUE, query: $query, first: ${REVIEW_SEARCH_SIZE}) {
    issueCount
    nodes {
      ... on PullRequest {
        ${LISTED_PULL_REQUEST_FIELDS}
        viewerLatestReview { state commit { oid } }
        viewerLatestReviewRequest { requestedReviewer { __typename ... on Team { combinedSlug } } }
        timelineItems(itemTypes: [REVIEW_REQUESTED_EVENT], first: ${REVIEW_REQUEST_EVENTS}) {
          nodes { ... on ReviewRequestedEvent { requestedReviewer { __typename ... on User { login } } } }
        }
      }
    }
  }
}`;

/**
 * The viewer's own PRs, with who is asked to review each, every reviewer's latest review, their latest approval or change request, and the latest dismissals.
 * A later comment hides a verdict from `latestReviews`, and `latestOpinionatedReviews` leaves out a dismissed one, so a push dismissal is read from its event.
 * A dismissal that names the commit it came with is GitHub dismissing a stale review on a push; one dismissed by hand names none.
 */
export const AUTHORED_SEARCH_QUERY = `query GuidedReviewAuthored($query: String!) {
  search(type: ISSUE, query: $query, first: ${REVIEW_SEARCH_SIZE}) {
    issueCount
    nodes {
      ... on PullRequest {
        ${LISTED_PULL_REQUEST_FIELDS}
        reviewRequests(first: ${AUTHORED_REVIEWERS}) {
          nodes { requestedReviewer { __typename ... on User { login } ... on Bot { login } ... on Mannequin { login } ... on Team { combinedSlug } } }
        }
        latestReviews(first: ${AUTHORED_REVIEWERS}) { nodes { state submittedAt author { login } commit { oid } } }
        latestOpinionatedReviews(first: ${AUTHORED_REVIEWERS}) { nodes { state submittedAt author { login } } }
        timelineItems(itemTypes: [REVIEW_DISMISSED_EVENT], last: ${AUTHORED_REVIEWERS}) {
          nodes { ... on ReviewDismissedEvent { previousReviewState pullRequestCommit { id } review { submittedAt author { login } } } }
        }
      }
    }
  }
}`;

const ListedPullRequest = z.object({
  number: z.number(),
  url: z.string(),
  title: z.string(),
  isDraft: z.boolean(),
  createdAt: z.string(),
  updatedAt: z.string(),
  headRefOid: z.string(),
  additions: z.number(),
  deletions: z.number(),
  changedFiles: z.number(),
  author: z.object({ login: z.string() }).nullable(),
  statusCheckRollup: z.object({ state: z.enum(["EXPECTED", "ERROR", "FAILURE", "PENDING", "SUCCESS"]) }).nullable(),
  reviews: z.object({ nodes: z.array(z.object({ viewerDidAuthor: z.boolean(), comments: z.object({ totalCount: z.number() }) })) }),
});

const ReviewState = z.enum(["PENDING", "COMMENTED", "APPROVED", "CHANGES_REQUESTED", "DISMISSED"]);

const ReviewSearchResponse = z.object({
  data: z.object({
    viewer: z.object({ login: z.string() }),
    search: z.object({
      issueCount: z.number(),
      nodes: z.array(
        ListedPullRequest.extend({
          viewerLatestReview: z.object({ state: ReviewState, commit: z.object({ oid: z.string() }).nullable() }).nullable(),
          viewerLatestReviewRequest: z
            .object({ requestedReviewer: z.object({ __typename: z.string(), combinedSlug: z.string().optional() }).nullable() })
            .nullable(),
          timelineItems: z.object({
            nodes: z.array(z.object({ requestedReviewer: z.object({ __typename: z.string(), login: z.string().optional() }).nullable() })),
          }),
        }),
      ),
    }),
  }),
});

const AuthoredPullRequest = ListedPullRequest.extend({
  reviewRequests: z.object({
    nodes: z.array(
      z.object({ requestedReviewer: z.object({ login: z.string().optional(), combinedSlug: z.string().optional() }).nullable() }),
    ),
  }),
  latestReviews: z.object({
    nodes: z.array(
      z.object({
        state: ReviewState,
        submittedAt: z.string().nullable(),
        author: z.object({ login: z.string() }).nullable(),
        commit: z.object({ oid: z.string() }).nullable(),
      }),
    ),
  }),
  latestOpinionatedReviews: z.object({
    nodes: z.array(z.object({ state: ReviewState, submittedAt: z.string().nullable(), author: z.object({ login: z.string() }).nullable() })),
  }),
  timelineItems: z.object({
    nodes: z.array(
      z.object({
        previousReviewState: z.string().optional(),
        pullRequestCommit: z.object({ id: z.string() }).nullish(),
        review: z.object({ submittedAt: z.string().nullable(), author: z.object({ login: z.string() }).nullable() }).nullish(),
      }),
    ),
  }),
});

const AuthoredSearchResponse = z.object({
  data: z.object({ search: z.object({ issueCount: z.number(), nodes: z.array(AuthoredPullRequest) }) }),
});

type ListedPullRequest = z.output<typeof ListedPullRequest>;
type SearchedPullRequest = z.output<typeof ReviewSearchResponse>["data"]["search"]["nodes"][number];
type AuthoredPullRequest = z.output<typeof AuthoredPullRequest>;

const CI_STATES: Record<NonNullable<ListedPullRequest["statusCheckRollup"]>["state"], CiState> = {
  SUCCESS: "success",
  FAILURE: "failure",
  ERROR: "failure",
  PENDING: "pending",
  EXPECTED: "pending",
};

const REVIEWER_STATES: Record<z.output<typeof ReviewState>, ReviewerState> = {
  PENDING: "requested",
  COMMENTED: "commented",
  APPROVED: "approved",
  CHANGES_REQUESTED: "changes-requested",
  DISMISSED: "commented",
};

/**
 * Whether the PR ever asked `login` for a review, by name or through a team.
 * A team request counts whichever team it was, as telling whether the viewer is in it takes the `read:org` scope.
 */
function wasAskedToReview(pr: SearchedPullRequest, login: string): boolean {
  return pr.timelineItems.nodes.some(({ requestedReviewer }) => requestedReviewer?.__typename === "Team" || requestedReviewer?.login === login);
}

/**
 * Where the viewer stands on a PR one of `REVIEW_SEARCHES` found. A PR they are asked to review is
 * `requested` whatever they said before, since being asked again is what makes it theirs again; a
 * dismissed review is still one they wrote, and a pending one is not written yet.
 */
function reviewRequestOf(pr: SearchedPullRequest, requested: boolean): ReviewRequest | null {
  const listed = listedOf(pr);
  if (listed === null) return null;
  const review = pr.viewerLatestReview?.state === "PENDING" ? null : pr.viewerLatestReview;
  const team = pr.viewerLatestReviewRequest?.requestedReviewer;
  return {
    ...listed,
    state: requested || review === null ? "requested" : REVIEWER_STATES[review.state],
    viaTeam: requested && team?.__typename === "Team" ? (team.combinedSlug ?? null) : null,
    changedSinceReview: review === null ? null : requested || review.commit?.oid !== pr.headRefOid,
  };
}

/**
 * The viewer's own PR with where each reviewer stands: their latest approval or change request, else their approval GitHub dismissed on a push, else that they commented.
 * A reviewer asked again is `requested`, as on GitLab, where asking again resets their state, unless they requested changes: a blocking review is never hidden.
 * The author's own reviews are replies to threads, not reviews of their PR, so they are left out.
 */
function authoredOf(pr: AuthoredPullRequest): AuthoredChangeRequest | null {
  const listed = listedOf(pr);
  if (listed === null) return null;
  const resets = new Map<string, string>();
  for (const { previousReviewState, pullRequestCommit, review } of pr.timelineItems.nodes) {
    if (previousReviewState !== "APPROVED" || !pullRequestCommit || !review?.submittedAt) continue;
    const login = userOf(review.author).login;
    const known = resets.get(login);
    if (known === undefined || Date.parse(review.submittedAt) > Date.parse(known)) resets.set(login, review.submittedAt);
  }
  const opinions = new Map(pr.latestOpinionatedReviews.nodes.map((opinion) => [userOf(opinion.author).login, opinion]));
  const reviews = pr.latestReviews.nodes.filter((review) => review.state !== "PENDING" && review.author?.login !== pr.author?.login);
  const asked = new Set(
    pr.reviewRequests.nodes.flatMap(({ requestedReviewer }) => {
      const name = requestedReviewer?.combinedSlug ?? requestedReviewer?.login;
      return name ? [name] : [];
    }),
  );
  const states = new Map<string, ReviewerState>();
  for (const review of reviews) {
    const login = userOf(review.author).login;
    states.set(login, standingOf(opinions.get(login), resets.get(login)) ?? REVIEWER_STATES[review.state]);
  }
  for (const name of asked) {
    if (states.get(name) !== "changes-requested") states.set(name, "requested");
  }
  const reviewers = [...states].map(([name, state]) => ({ name, state }));
  return {
    ...listed,
    status: reviewStatusOf(reviewers),
    reviewers,
    reviewedSinceLastPush: reviews.some(
      (review) => review.state !== "DISMISSED" && states.get(userOf(review.author).login) !== "requested" && review.commit?.oid === pr.headRefOid,
    ),
    latestReviewAt: latestOf(reviews.flatMap((review) => (review.submittedAt === null ? [] : [review.submittedAt]))),
  };
}

/** A reviewer's verdict, or the approval a push took from them when that came after it; null when they gave none. */
function standingOf(opinion: AuthoredPullRequest["latestOpinionatedReviews"]["nodes"][number] | undefined, resetAt: string | undefined): ReviewerState | null {
  const verdict = opinion?.state === "APPROVED" || opinion?.state === "CHANGES_REQUESTED" ? opinion : undefined;
  if (resetAt !== undefined && (verdict?.submittedAt == null || Date.parse(resetAt) > Date.parse(verdict.submittedAt))) return "unapproved";
  return verdict === undefined ? null : REVIEWER_STATES[verdict.state];
}

function listedOf(pr: ListedPullRequest): ListedChangeRequest | null {
  const ref = parsePullRequestUrl(pr.url);
  if (ref === null) return null;
  return {
    forge: "github",
    host: ref.host,
    project: ref.project,
    number: ref.number,
    url: ref.url,
    title: pr.title,
    author: userOf(pr.author).login,
    isDraft: pr.isDraft,
    createdAt: pr.createdAt,
    updatedAt: pr.updatedAt,
    headSha: pr.headRefOid,
    additions: pr.additions,
    deletions: pr.deletions,
    fileCount: pr.changedFiles,
    ci: pr.statusCheckRollup ? CI_STATES[pr.statusCheckRollup.state] : null,
    pendingDrafts: pr.reviews.nodes.find((pending) => pending.viewerDidAuthor)?.comments.totalCount ?? 0,
  };
}

/** Any mutation whose answer is only read for its errors, which `gh` turns into a failed exit. */
const MutationResponse = z.object({ data: z.unknown() });

export type GitHubForgeOptions = {
  run: CommandRunner;
  /** The `gh` executable from the settings. */
  gh: () => Promise<string>;
};

export function createGitHubForge(options: GitHubForgeOptions): Forge {
  const gh = createCli({ run: options.run, binary: options.gh, name: "gh", env: GH_ENV });

  /** A GraphQL request, its variables in a JSON body on stdin so none is retyped. */
  const graphql = <Schema extends z.ZodType>(ref: ChangeRequestRef, schema: Schema, query: string, variables: Record<string, unknown>) =>
    gh.json(schema, ["api", "graphql", "--hostname", ref.host, "--input", "-"], { input: JSON.stringify({ query, variables }) });

  const pullRequestVariables = (ref: ChangeRequestRef) => {
    const [owner, name] = ref.project.split("/") as [string, string];
    return { owner, name, number: ref.number };
  };

  /** A pull request's conversation is its issue's, so a comment on it as a whole is an issue comment. */
  const postIssueComment = async (ref: ChangeRequestRef, body: string) => {
    await gh.text(["api", "--hostname", ref.host, "--method", "POST", `repos/${ref.project}/issues/${ref.number}/comments`, "--input", "-"], {
      input: JSON.stringify({ body }),
    });
  };

  /**
   * The viewer's pending review, started on `target`'s head when there is none. Two drafts saved at
   * once would otherwise both find none and start two, and GitHub turns the second down. A submit
   * and a discard queue here too, so neither acts on a review another is starting.
   */
  const creating = oneAtATimePer<string>();
  const oneAtATime = <T>(ref: ChangeRequestRef, run: () => Promise<T>): Promise<T> => creating(ref.url, run);

  /** The pull request's node ID and the viewer's pending review on it, if any. */
  const findPendingReview = async (ref: ChangeRequestRef): Promise<{ pullRequestId: string; reviewId: string | null }> => {
    const response = await graphql(ref, PendingReviewResponse, PENDING_REVIEW_QUERY, pullRequestVariables(ref));
    const pr = response.data.repository?.pullRequest;
    if (!pr) throw new ForgeError(`${ref.project} has no pull request #${ref.number}.`);
    return { pullRequestId: pr.id, reviewId: pr.reviews.nodes.find((review) => review.viewerDidAuthor)?.id ?? null };
  };

  const pendingReview = async (target: DraftTarget): Promise<string> => {
    const { pullRequestId, reviewId } = await findPendingReview(target.ref);
    if (reviewId !== null) return reviewId;
    const started = await graphql(target.ref, StartReviewResponse, START_REVIEW_MUTATION, {
      pullRequestId,
      commitOID: target.headSha,
    });
    return started.data.addPullRequestReview.pullRequestReview.id;
  };

  return {
    kind: "github",
    urlHint: "a GitHub pull request URL, like https://github.com/owner/repo/pull/123",

    async matchUrl(url) {
      return parsePullRequestUrl(url);
    },

    async findByBranch(repository, branch): Promise<BranchChangeRequest[] | null> {
      if (repository.host.toLowerCase().replace(/^www\./, "") !== GITHUB_HOST) return null;
      // `--head` takes a branch name only, so a fork's PR from a branch of the same name is found too;
      // the fast-forward, which fetches the PR's own ref, is what tells them apart.
      const pullRequests = await gh.json(BranchPullRequestsResponse, [
        "pr",
        "list",
        "--repo",
        `${GITHUB_HOST}/${repository.project}`,
        "--head",
        branch,
        "--state",
        "open",
        "--json",
        "number,url,title,author,headRefOid",
        "--limit",
        String(MAX_BRANCH_CHANGE_REQUESTS),
      ]);
      return pullRequests.flatMap((pr) => {
        const ref = parsePullRequestUrl(pr.url);
        return ref === null ? [] : [{ ref, title: pr.title, author: userOf(pr.author).login, headSha: pr.headRefOid }];
      });
    },

    async fetchChangeRequest(ref) {
      const [owner, name] = ref.project.split("/") as [string, string];
      // Variables go in a JSON body on stdin: `-F` would turn a repository called `123` into a number.
      const input = JSON.stringify({ query: PULL_REQUEST_QUERY, variables: { owner, name, number: ref.number } });
      const response = await gh.json(PullRequestResponse, ["api", "graphql", "--hostname", ref.host, "--input", "-"], { input });
      const pr = response.data.repository?.pullRequest;
      if (!pr) throw new ForgeError(`${ref.project} has no pull request #${ref.number}.`);

      // The REST listing is the authoritative one, and the only one that carries each file's patch.
      const files = await gh.json(FilesResponse, [
        "api",
        "--hostname",
        ref.host,
        `repos/${ref.project}/pulls/${ref.number}/files?per_page=100`,
        "--paginate",
      ]);

      return {
        ref,
        title: pr.title,
        description: pr.body,
        author: userOf(pr.author),
        state: STATES[pr.state],
        isDraft: pr.isDraft,
        baseBranch: pr.baseRefName,
        headBranch: pr.headRefName,
        baseSha: pr.baseRefOid,
        startSha: pr.baseRefOid,
        headSha: pr.headRefOid,
        additions: pr.additions,
        deletions: pr.deletions,
        commits: pr.commits.nodes.map(({ commit }) => ({
          sha: commit.oid,
          headline: commit.messageHeadline,
          body: commit.messageBody,
          author: commit.author?.user?.login ?? commit.author?.name ?? "unknown",
          authoredAt: commit.authoredDate,
          parents: commit.parents.nodes.map((parent) => parent.oid),
        })),
        linkedIssues: pr.closingIssuesReferences.nodes.map((issue) => ({ ...issue })),
        files: files.map((file) => ({
          path: file.filename,
          previousPath: file.previous_filename ?? null,
          status: file.status satisfies ChangedFileStatus,
          additions: file.additions,
          deletions: file.deletions,
          patch: file.patch ?? null,
        })),
      } satisfies ChangeRequest;
    },

    async fetchHead(ref): Promise<ChangeRequestHead> {
      const [owner, name] = ref.project.split("/") as [string, string];
      const input = JSON.stringify({ query: PULL_REQUEST_HEAD_QUERY, variables: { owner, name, number: ref.number } });
      const response = await gh.json(PullRequestHeadResponse, ["api", "graphql", "--hostname", ref.host, "--input", "-"], { input });
      const pr = response.data.repository?.pullRequest;
      if (!pr) throw new ForgeError(`${ref.project} has no pull request #${ref.number}.`);
      return { headSha: pr.headRefOid, state: STATES[pr.state], description: pr.body };
    },

    async fetchAttachment(ref, url, maxBytes) {
      if (!isAttachmentUrl(ref, url)) return null;
      // A full URL: gh sends its token to that host and follows the redirect to the signed file.
      return gh.bytes(["api", url], { maxBytes });
    },

    async commitsSince(ref, sha) {
      const response = await graphql(ref, PullRequestCommitsResponse, PULL_REQUEST_COMMITS_QUERY, pullRequestVariables(ref));
      const commits = response.data.repository?.pullRequest?.commits;
      if (!commits) throw new ForgeError(`${ref.project} has no pull request #${ref.number}.`);
      const newestFirst = commits.nodes.map((node) => node.commit.oid).reverse();
      return commitsSinceIn(newestFirst, sha, commits.totalCount <= newestFirst.length);
    },

    /** One query over the PR's own commits, which are the ones asked about. */
    async commitChangeRequests(ref, shas) {
      const response = await graphql(ref, CommitPullRequestsResponse, COMMIT_PULL_REQUESTS_QUERY, pullRequestVariables(ref));
      const commits = response.data.repository?.pullRequest?.commits;
      if (!commits) throw new ForgeError(`${ref.project} has no pull request #${ref.number}.`);
      const listed = new Map(
        commits.nodes.map(({ commit }) => [
          commit.oid,
          commit.associatedPullRequests.nodes.map((pr) => ({
            number: pr.number,
            url: pr.url,
            title: pr.title,
            state: STATES[pr.state],
            sourceBranch: pr.headRefName,
            targetBranch: pr.baseRefName,
          })),
        ]),
      );
      return new Map(shas.map((sha) => [sha, listed.get(sha) ?? []]));
    },

    async changedPaths(ref, from, to) {
      const compare = await gh.json(CompareResponse, ["api", "--hostname", ref.host, `repos/${ref.project}/compare/${from}...${to}`]);
      if (compare.files.length >= MAX_COMPARE_FILES) return null;
      return [...new Set(compare.files.flatMap((file) => [file.filename, ...(file.previous_filename ? [file.previous_filename] : [])]))];
    },

    async currentUser(ref): Promise<ForgeUser> {
      const user = await gh.json(UserResponse, ["api", "--hostname", ref.host, "user"]);
      return { login: user.login, name: user.name ?? null };
    },

    async cloneRepository(ref, directory) {
      // gh picks the protocol and credentials the reviewer set it up with, which `git clone` would not.
      await gh.text(["repo", "clone", `${ref.host}/${ref.project}`, directory], { timeoutMs: CLONE_TIMEOUT_MS });
    },

    async listDrafts(ref) {
      const drafts: Draft[] = [];
      let after: string | null = null;
      for (;;) {
        const response: z.output<typeof DraftsResponse> = await graphql(ref, DraftsResponse, DRAFTS_QUERY, {
          ...pullRequestVariables(ref),
          after,
        });
        const pr = response.data.repository?.pullRequest;
        if (!pr) throw new ForgeError(`${ref.project} has no pull request #${ref.number}.`);
        const review = pr.reviews.nodes.find((candidate) => candidate.viewerDidAuthor);
        if (!review) return [];
        for (const thread of pr.reviewThreads.nodes) {
          for (const comment of thread.comments.nodes) {
            if (comment.pullRequestReview?.id === review.id) drafts.push({ id: comment.id, body: comment.body, location: locationOf(thread) });
          }
        }
        const { hasNextPage, endCursor } = pr.reviewThreads.pageInfo;
        if (!hasNextPage || endCursor === null) return drafts;
        after = endCursor;
      }
    },

    async createDraft(target, { anchor, body }) {
      // A pending review has no comment on the pull request as a whole, only its body, which the service keeps.
      if (anchor.kind === "general") throw new ForgeError("GitHub keeps a comment on the pull request as a whole in the review body, not as a draft.");
      return oneAtATime(target.ref, async () => {
        const pullRequestReviewId = await pendingReview(target);
        const input = { pullRequestReviewId, path: anchor.path, body, ...threadAnchor(anchor) };
        const response = await graphql(target.ref, AddThreadResponse, ADD_THREAD_MUTATION, { input });
        const thread = response.data.addPullRequestReviewThread.thread;
        const comment = thread?.comments.nodes[0];
        if (!thread || !comment) throw new ForgeError("GitHub did not add the comment to your pending review.");
        return { id: comment.id, body: comment.body, location: locationOf(thread) };
      });
    },

    async updateDraft(ref, draftId, body) {
      await graphql(ref, MutationResponse, UPDATE_COMMENT_MUTATION, { id: draftId, body });
    },

    async deleteDraft(ref, draftId) {
      await graphql(ref, MutationResponse, DELETE_COMMENT_MUTATION, { id: draftId });
    },

    // GitHub refuses to edit a pending review's body while it is empty, as it is on every review started without one.
    takesGeneralDrafts: false,

    async postComment(ref, body) {
      await postIssueComment(ref, body);
    },

    async startDiscussion(ref, body) {
      await postIssueComment(ref, body);
    },

    async submitReview(target, { verdict, body }) {
      return oneAtATime(target.ref, async () => {
        // One mutation publishes the comments, the body and the verdict together, so it lands whole or not at all.
        const steps = new SubmitSteps();
        const submitted = await steps.run("submit", SUBMIT_LABELS[verdict], async () => {
          const id = await pendingReview(target);
          await graphql(target.ref, MutationResponse, SUBMIT_REVIEW_MUTATION, { id, event: EVENTS[verdict], body });
        });
        return { published: submitted.ok, steps: steps.steps };
      });
    },

    async discardReview(ref) {
      await oneAtATime(ref, async () => {
        const { reviewId } = await findPendingReview(ref);
        if (reviewId !== null) await graphql(ref, MutationResponse, DELETE_REVIEW_MUTATION, { id: reviewId });
      });
    },

    async listChangeRequests(): Promise<ListedHost[]> {
      const search = <T extends z.ZodType>(response: T, query: string, terms: string) =>
        gh.json(response, ["api", "graphql", "--hostname", GITHUB_HOST, "--input", "-"], {
          input: JSON.stringify({ query, variables: { query: terms } }),
        });
      const hasMore = (...answers: { data: { search: { issueCount: number; nodes: unknown[] } } }[]) =>
        answers.some(({ data }) => data.search.issueCount > data.search.nodes.length);
      try {
        const [requested, reviewed, authored] = await Promise.all([
          search(ReviewSearchResponse, REVIEW_SEARCH_QUERY, REVIEW_SEARCHES.requested),
          search(ReviewSearchResponse, REVIEW_SEARCH_QUERY, REVIEW_SEARCHES.reviewed),
          search(AuthoredSearchResponse, AUTHORED_SEARCH_QUERY, REVIEW_SEARCHES.authored),
        ]);
        const assigned = [
          ...requested.data.search.nodes.map((pr) => reviewRequestOf(pr, true)),
          ...reviewed.data.search.nodes.filter((pr) => wasAskedToReview(pr, reviewed.data.viewer.login)).map((pr) => reviewRequestOf(pr, false)),
        ].filter((request) => request !== null);
        return [
          {
            forge: "github",
            host: GITHUB_HOST,
            assigned,
            authored: authored.data.search.nodes.map(authoredOf).filter((request) => request !== null),
            truncated: { assigned: hasMore(requested, reviewed), authored: hasMore(authored) },
            error: null,
          },
        ];
      } catch (error) {
        if (!(error instanceof ForgeError)) throw error;
        return [unlistedHost("github", GITHUB_HOST, error.message)];
      }
    },
  };
}

type GitHubSide = z.output<typeof DiffSide>;

/**
 * Where a thread goes, in `AddPullRequestReviewThreadInput`'s fields: a removed line on the LEFT
 * side by its old number, any other line on the RIGHT by its new one; a range's first line in
 * `startLine`/`startSide` and its last in `line`/`side`; a file as subject type FILE with no line.
 */
function threadAnchor(anchor: Exclude<DraftAnchor, { kind: "general" }>): Record<string, string | number> {
  const point = (line: AnchorLine): { line: number; side: GitHubSide } =>
    line.kind === "removed" ? { line: line.oldLine!, side: "LEFT" } : { line: line.newLine!, side: "RIGHT" };
  switch (anchor.kind) {
    case "line":
      return { subjectType: "LINE", ...point(anchor.line) };
    case "range": {
      const start = point(anchor.start);
      return { subjectType: "LINE", startLine: start.line, startSide: start.side, ...point(anchor.end) };
    }
    case "file":
      return { subjectType: "FILE" };
  }
}

/** A thread's place as a `DraftLocation`; an outdated thread, which has no current line, by its original one. */
function locationOf(thread: z.output<typeof Thread>): DraftLocation {
  const { path } = thread;
  const current = thread.line !== null;
  const endLine = current ? thread.line : thread.originalLine;
  const startLine = current ? thread.startLine : thread.originalStartLine;
  if (thread.subjectType === "FILE" || endLine === null) return { kind: "file", path };
  const end = { side: sideOf(thread.diffSide), line: endLine };
  if (startLine === null) return { kind: "line", path, line: end };
  const start = { side: sideOf(thread.startDiffSide ?? thread.diffSide), line: startLine };
  if (start.side === end.side && start.line === end.line) return { kind: "line", path, line: end };
  return { kind: "range", path, start, end };
}

function sideOf(side: GitHubSide): "old" | "new" {
  return side === "LEFT" ? "old" : "new";
}

const STATES: Record<"OPEN" | "CLOSED" | "MERGED", ChangeRequestState> = {
  OPEN: "open",
  CLOSED: "closed",
  MERGED: "merged",
};

const NAME = /^[A-Za-z0-9_.-]+$/;

/**
 * A pull request URL on github.com, with or without its scheme and with whatever tab or anchor it
 * was copied from; anything else is null.
 */
/**
 * Where GitHub keeps what is pasted into a description: `user-attachments` now, a repository's
 * `assets` before that, and `user-images` before either.
 */
export function isAttachmentUrl(ref: ChangeRequestRef, url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== "https:") return false;
  if (parsed.hostname === "user-images.githubusercontent.com") return true;
  return parsed.hostname === ref.host && /^\/(user-attachments\/assets|[^/]+\/[^/]+\/assets\/\d+)\/[\w-]+$/.test(parsed.pathname);
}

export function parsePullRequestUrl(text: string): ChangeRequestRef | null {
  const trimmed = text.trim();
  let url: URL;
  try {
    url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  const host = url.hostname.toLowerCase().replace(/^www\./, "");
  if (host !== GITHUB_HOST) return null;

  const [owner, repo, kind, number] = url.pathname.split("/").filter((segment) => segment !== "");
  if (owner === undefined || repo === undefined || kind !== "pull" || number === undefined) return null;
  if (!NAME.test(owner) || !NAME.test(repo) || owner.startsWith(".") || repo.startsWith(".")) return null;
  if (!/^[1-9]\d{0,9}$/.test(number)) return null;

  const project = `${owner}/${repo}`;
  return {
    forge: "github",
    host,
    project,
    number: Number(number),
    url: `https://${host}/${project}/pull/${number}`,
  };
}
