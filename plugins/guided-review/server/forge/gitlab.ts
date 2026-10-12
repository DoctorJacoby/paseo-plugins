import { createHash } from "node:crypto";
import { z } from "zod";
import type { Draft, DraftLocation, LineRef } from "../../shared/drafts.ts";
import type { CommandRunner } from "../command-runner.ts";
import type { Verdict } from "../../shared/submit.ts";
import type { AuthoredChangeRequest, CiState, ListedChangeRequest, ListedHost, ReviewerState, ReviewRequest } from "../../shared/inbox.ts";
import { createCli, type Cli } from "./cli.ts";
import { GITHUB_HOST } from "./github.ts";
import { CLONE_TIMEOUT_MS, COMMIT_READS_AT_ONCE, mapAtMost, MAX_BRANCH_CHANGE_REQUESTS, MAX_COMMITS, MAX_LINKED_ISSUES, latestOf, reviewStatusOf, unlistedHost, userOf } from "./common.ts";
import { SubmitSteps } from "./submit-steps.ts";
import {
  commitsSinceIn,
  ForgeError,
  type AnchorLine,
  type BranchChangeRequest,
  type ChangedFile,
  type ChangeRequest,
  type ChangeRequestHead,
  type ChangeRequestRef,
  type ChangeRequestState,
  type CommitChangeRequest,
  type DraftAnchor,
  type DraftTarget,
  type Forge,
  type ForgeUser,
  type RepositoryRef,
  type SubmitOutcome,
} from "./port.ts";

/** No prompts, no update check and no colour codes: the output is parsed, not read. */
const GLAB_ENV = { GLAB_CHECK_UPDATE: "0", GLAB_NO_PROMPT: "1", NO_COLOR: "1", GIT_TERMINAL_PROMPT: "0" };

/**
 * Never passed on to `glab`. A `glab` wrapper can post as a bot account when it sees an agent's
 * environment, `PASEO_AGENT_ID` being the one Paseo sets, and a daemon restarted from an agent's
 * terminal inherits it. The review is the reviewer's own, so it is read and written as them.
 */
export const GLAB_UNSET_ENV = ["PASEO_AGENT_ID", "GITLAB_BOT_IDENTITY"] as const;

const ProjectResponse = z.object({ id: z.number() });

const MergeRequestResponse = z.object({
  title: z.string(),
  description: z.string().nullable(),
  state: z.enum(["opened", "closed", "locked", "merged"]),
  draft: z.boolean().optional(),
  work_in_progress: z.boolean().optional(),
  author: z.object({ username: z.string(), name: z.string().nullish() }).nullable(),
  source_branch: z.string(),
  target_branch: z.string(),
  /** Null until GitLab has worked out the MR's first diff. */
  diff_refs: z.object({ base_sha: z.string(), start_sha: z.string(), head_sha: z.string() }).nullable(),
});

/** `sha` is the source branch's head, which GitLab has before it has worked out the diff at it. */
const MergeRequestHeadResponse = z.object({
  state: z.enum(["opened", "closed", "locked", "merged"]),
  description: z.string().nullable(),
  sha: z.string().nullable(),
  diff_refs: z.object({ head_sha: z.string() }).nullable(),
});

const DiffEntry = z.object({
  old_path: z.string(),
  new_path: z.string(),
  new_file: z.boolean(),
  renamed_file: z.boolean(),
  deleted_file: z.boolean(),
  /** Empty when GitLab withheld it as too large or collapsed, and for a change with no lines. */
  diff: z.string(),
});

const CommitsResponse = z.array(
  z.object({
    id: z.string(),
    title: z.string(),
    message: z.string(),
    author_name: z.string(),
    authored_date: z.string(),
    parent_ids: z.array(z.string()),
  }),
);

/** `compare_timeout` is GitLab giving up on the diff part-way, which leaves `diffs` short. */
const CompareResponse = z.object({
  compare_timeout: z.boolean(),
  diffs: z.array(z.object({ old_path: z.string(), new_path: z.string() })),
});

const CommitMergeRequestsResponse = z.array(
  z.object({
    iid: z.number(),
    web_url: z.string(),
    title: z.string(),
    state: z.enum(["opened", "closed", "locked", "merged"]),
    source_branch: z.string(),
    target_branch: z.string(),
  }),
);

const CommitIdsResponse = z.array(z.object({ id: z.string() }));

/** How far back a count of the commits since a guide's head goes. */
const COMMITS_SINCE_PAGE = 100;

/** An issue in an external tracker comes back with an ID and a title, and no IID. */
const ClosesIssuesResponse = z.array(
  z.object({
    iid: z.number().optional(),
    web_url: z.string().optional(),
    title: z.string().optional(),
    description: z.string().nullish(),
    state: z.string().optional(),
  }),
);

const UserResponse = z.object({ username: z.string(), name: z.string().nullish() });

const BranchMergeRequestsResponse = z.array(
  z.object({
    title: z.string(),
    web_url: z.string(),
    author: z.object({ username: z.string() }).nullable(),
    sha: z.string(),
  }),
);

/** One end of a `line_range`, as GitLab keeps it. */
const LineRangeEnd = z.object({
  line_code: z.string().nullish(),
  type: z.string().nullish(),
  old_line: z.number().nullish(),
  new_line: z.number().nullish(),
});

/**
 * A draft's or a note's position, with only the fields a draft note takes, so one read back can be
 * sent again as it is. An MR-level draft has none, or one whose fields are all null.
 */
const PositionResponse = z.object({
  base_sha: z.string().nullish(),
  start_sha: z.string().nullish(),
  head_sha: z.string().nullish(),
  position_type: z.string().nullish(),
  old_path: z.string().nullish(),
  new_path: z.string().nullish(),
  old_line: z.number().nullish(),
  new_line: z.number().nullish(),
  line_range: z.object({ start: LineRangeEnd, end: LineRangeEnd }).nullish(),
});

type Position = z.output<typeof PositionResponse>;

const DraftNoteResponse = z.object({
  id: z.number(),
  note: z.string(),
  /** Set on a reply to a published thread, whose place is the thread's rather than the draft's own. */
  discussion_id: z.string().nullish(),
  position: PositionResponse.nullish(),
});

const DiscussionResponse = z.object({
  id: z.string(),
  notes: z.array(z.object({ position: PositionResponse.nullish() })),
});

/** `GET version`: `19.5.0-pre`, `17.11.3-ee`. */
const VersionResponse = z.object({ version: z.string() });

/** `GET …/reviewers`: each reviewer with their state, `requested_changes` among them. */
const ReviewersResponse = z.array(z.object({ user: z.object({ username: z.string() }), state: z.string().nullish() }));

/** A GraphQL mutation's answer, which reports a failure as HTTP 200 with `errors` in the payload. */
const RequestChangesResponse = z.object({
  data: z.object({ mergeRequestRequestChanges: z.object({ errors: z.array(z.string()) }).nullable() }).nullish(),
  errors: z.array(z.object({ message: z.string() })).nullish(),
});

/** Takes the project's full path, not its numeric ID, and the IID as a string. */
export const REQUEST_CHANGES_MUTATION =
  "mutation($projectPath: ID!, $iid: String!) { mergeRequestRequestChanges(input: { projectPath: $projectPath, iid: $iid }) { errors } }";

/** The first GitLab whose `bulk_publish` takes `note` and `reviewer_state`; an older one ignores both. */
const BULK_PUBLISH_BODY_VERSION = [19, 2] as const;

/** The first GitLab whose reviewer records say when they last changed, which tells a push after a review apart. */
const REVIEW_LIST_VERSION = [19, 2] as const;

/** The first GitLab with an API to download a project's uploads; before it they are only on the web, behind a browser login. */
const UPLOAD_DOWNLOAD_VERSION = [17, 4] as const;

/** Whether a version GitLab gives as `19.5.0-pre` is `need` or newer; one that cannot be read is not. */
function isAtLeast(version: string, [needMajor, needMinor]: readonly [number, number]): boolean {
  const match = /^(\d+)\.(\d+)/.exec(version);
  if (match === null) return false;
  const [major, minor] = [Number(match[1]), Number(match[2])];
  return major > needMajor || (major === needMajor && minor >= needMinor);
}

/** Every MR on one page: GitLab caps a GraphQL page at 100. */
const REVIEW_LIST_SIZE = 100;

/**
 * What either list asks of an MR.
 * The first commit is the head, newest first.
 */
const LISTED_MERGE_REQUEST_FIELDS = `webUrl title draft createdAt updatedAt diffHeadSha
        author { username }
        diffStatsSummary { additions deletions fileCount }
        headPipeline { status }
        commits(first: 1) { nodes { sha committedDate } }`;

const REVIEWER_FIELDS = "reviewers { nodes { username mergeRequestInteraction { reviewState approved updatedAt } } }";

/**
 * The open MRs the viewer is a reviewer of, with their own reviewer record among the MR's reviewers, since GitLab has no field for the viewer's alone.
 * The open MRs the viewer authored, with every reviewer's record and whoever approved without being one.
 * Both lists are one query, so a host fails for both at once, and the query has to stay under the complexity GitLab allows a signed-in user.
 */
export const REVIEW_LIST_QUERY = `query GuidedReviewInbox {
  currentUser {
    username
    reviewRequestedMergeRequests(state: opened, first: ${REVIEW_LIST_SIZE}, sort: UPDATED_DESC) {
      pageInfo { hasNextPage }
      nodes {
        ${LISTED_MERGE_REQUEST_FIELDS}
        ${REVIEWER_FIELDS}
      }
    }
    authoredMergeRequests(state: opened, first: ${REVIEW_LIST_SIZE}, sort: UPDATED_DESC) {
      pageInfo { hasNextPage }
      nodes {
        ${LISTED_MERGE_REQUEST_FIELDS}
        ${REVIEWER_FIELDS}
        approvedBy { nodes { username } }
        mergeRequestDiffs(first: 1) { nodes { createdAt } }
      }
    }
  }
}`;

const GITLAB_REVIEW_STATES = ["UNREVIEWED", "REVIEW_STARTED", "REVIEWED", "REQUESTED_CHANGES", "APPROVED", "UNAPPROVED"] as const;

const ListedMergeRequest = z.object({
  webUrl: z.string(),
  title: z.string(),
  draft: z.boolean(),
  createdAt: z.string(),
  updatedAt: z.string(),
  diffHeadSha: z.string().nullable(),
  author: z.object({ username: z.string() }).nullable(),
  diffStatsSummary: z.object({ additions: z.number(), deletions: z.number(), fileCount: z.number() }).nullable(),
  headPipeline: z.object({ status: z.string() }).nullable(),
  commits: z.object({ nodes: z.array(z.object({ sha: z.string(), committedDate: z.string().nullable() })) }).nullable(),
});

const ReviewedMergeRequest = ListedMergeRequest.extend({
  reviewers: z.object({
    nodes: z.array(
      z.object({
        username: z.string(),
        mergeRequestInteraction: z
          .object({ reviewState: z.enum(GITLAB_REVIEW_STATES).nullable(), approved: z.boolean(), updatedAt: z.string().nullable() })
          .nullable(),
      }),
    ),
  }),
});

const AuthoredMergeRequest = ReviewedMergeRequest.extend({
  approvedBy: z.object({ nodes: z.array(z.object({ username: z.string() })) }),
  /** The MR's diff versions, newest first, so the first is the head's push. */
  mergeRequestDiffs: z.object({ nodes: z.array(z.object({ createdAt: z.string() })) }).nullable(),
});

function pageOf<Node extends z.ZodType>(node: Node) {
  return z.object({ pageInfo: z.object({ hasNextPage: z.boolean() }), nodes: z.array(node) });
}

/** GraphQL reports a failure as HTTP 200 with `errors`, and `data` null where it could not answer. */
const ReviewListResponse = z.object({
  data: z
    .object({
      currentUser: z
        .object({
          username: z.string(),
          reviewRequestedMergeRequests: pageOf(ReviewedMergeRequest),
          authoredMergeRequests: pageOf(AuthoredMergeRequest),
        })
        .nullable(),
    })
    .nullish(),
  errors: z.array(z.object({ message: z.string() })).nullish(),
});

type ListedMergeRequest = z.output<typeof ListedMergeRequest>;
type ReviewedMergeRequest = z.output<typeof ReviewedMergeRequest>;
type AuthoredMergeRequest = z.output<typeof AuthoredMergeRequest>;
type ReviewerRecord = ReviewedMergeRequest["reviewers"]["nodes"][number];

const LISTED_STATES: Record<(typeof GITLAB_REVIEW_STATES)[number], ReviewerState> = {
  UNREVIEWED: "requested",
  REVIEW_STARTED: "requested",
  REVIEWED: "commented",
  REQUESTED_CHANGES: "changes-requested",
  APPROVED: "approved",
  UNAPPROVED: "unapproved",
};

/** A pipeline still to finish is pending; one that ended without passing or failing, like a cancelled one, has no CI state. */
const CI_STATES: Record<string, CiState> = {
  SUCCESS: "success",
  FAILED: "failure",
  CREATED: "pending",
  WAITING_FOR_RESOURCE: "pending",
  WAITING_FOR_CALLBACK: "pending",
  PREPARING: "pending",
  PENDING: "pending",
  RUNNING: "pending",
  SCHEDULED: "pending",
};

/**
 * An MR as the review list shows it, by the viewer's own reviewer record. GitLab keeps no record of
 * the commit a review was of, so a review older than the head commit counts as changed since; one
 * GitLab took an approval back from was pushed to, and one still unreviewed may have been asked again.
 */
function reviewRequestOf(mr: ReviewedMergeRequest, viewer: string): ReviewRequest | null {
  const listed = listedOf(mr);
  if (listed === null) return null;
  const own = mr.reviewers.nodes.find((reviewer) => sameUser(reviewer.username, viewer))?.mergeRequestInteraction;
  const reviewState = own?.reviewState ?? "UNREVIEWED";
  const head = mr.commits?.nodes[0];
  const state = reviewerStateOf(own ?? null);
  let changedSinceReview: boolean | null = null;
  if (reviewState === "UNAPPROVED") changedSinceReview = true;
  else if (state !== "requested" && own?.updatedAt && head?.committedDate) {
    changedSinceReview = Date.parse(head.committedDate) > Date.parse(own.updatedAt);
  }
  return { ...listed, state, viaTeam: null, changedSinceReview };
}

function reviewerStateOf(interaction: ReviewerRecord["mergeRequestInteraction"]): ReviewerState {
  return interaction?.approved ? "approved" : LISTED_STATES[interaction?.reviewState ?? "UNREVIEWED"];
}

function sameUser(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

/**
 * The viewer's own MR with where each reviewer stands, and anyone who approved without being asked.
 * GitLab gives the same state to an approval taken back by a push and one its reviewer revoked, so both read as an approval reset.
 * It keeps no record of the commit a review was of, so a review after the head's push counts as one since the push.
 */
function authoredOf(mr: AuthoredMergeRequest): AuthoredChangeRequest | null {
  const listed = listedOf(mr);
  if (listed === null) return null;
  const others = mr.reviewers.nodes.filter((reviewer) => !sameUser(reviewer.username, listed.author));
  const reviewers = others.map((reviewer) => ({ name: reviewer.username, state: reviewerStateOf(reviewer.mergeRequestInteraction) }));
  for (const { username } of mr.approvedBy.nodes) {
    if (!sameUser(username, listed.author) && !reviewers.some((reviewer) => sameUser(reviewer.name, username))) reviewers.push({ name: username, state: "approved" });
  }
  const reviewedAt = others.flatMap((reviewer) => {
    const at = reviewer.mergeRequestInteraction?.updatedAt;
    return at && REVIEWED_STATES.has(reviewerStateOf(reviewer.mergeRequestInteraction)) ? [at] : [];
  });
  const pushedAt = mr.mergeRequestDiffs?.nodes[0]?.createdAt;
  return {
    ...listed,
    status: reviewStatusOf(reviewers),
    reviewers,
    reviewedSinceLastPush: reviewedAt.length === 0 ? false : pushedAt ? reviewedAt.some((at) => Date.parse(at) > Date.parse(pushedAt)) : null,
    latestReviewAt: latestOf(reviewedAt),
  };
}

/** The states a reviewer reaches by reviewing, rather than by being asked or by GitLab taking an approval back. */
const REVIEWED_STATES: ReadonlySet<ReviewerState> = new Set(["commented", "changes-requested", "approved"]);

function listedOf(mr: ListedMergeRequest): ListedChangeRequest | null {
  const ref = parseMergeRequestUrl(mr.webUrl);
  if (ref === null) return null;
  return {
    forge: "gitlab",
    host: ref.host,
    project: ref.project,
    number: ref.number,
    url: ref.url,
    title: mr.title,
    author: userOf(mr.author ? { login: mr.author.username } : null).login,
    isDraft: mr.draft,
    createdAt: mr.createdAt,
    updatedAt: mr.updatedAt,
    headSha: mr.diffHeadSha ?? mr.commits?.nodes[0]?.sha ?? "",
    additions: mr.diffStatsSummary?.additions ?? 0,
    deletions: mr.diffStatsSummary?.deletions ?? 0,
    fileCount: mr.diffStatsSummary?.fileCount ?? 0,
    ci: (mr.headPipeline && CI_STATES[mr.headPipeline.status]) ?? null,
    pendingDrafts: null,
  };
}

/**
 * The hosts `glab auth status --all` reports, each by the line naming it at the start of its block,
 * with why glab cannot use it, if it says so in an `x` line, and whether it is logged in there. It
 * exits 1 when any host failed, so the report is read whole.
 */
export function parseAuthStatus(report: string): { host: string; loggedIn: boolean; problem: string | null }[] {
  const hosts = [...report.matchAll(/^([a-z0-9][a-z0-9.-]*(?::\d+)?)\s*$/gim)].map((match) => match[1]!.toLowerCase());
  return [...new Set(hosts)].map((host) => {
    const escaped = host.replaceAll(".", "\\.");
    const problem = new RegExp(`^\\s*x ${escaped}: (.+)$`, "im").exec(report)?.[1]?.trim() ?? null;
    return { host, loggedIn: new RegExp(`Logged in to ${escaped} as `, "i").test(report), problem };
  });
}

/** The reviewer state a bulk publish sets for each verdict; an approval is a call of its own after it. */
const REVIEWER_STATES: Record<Verdict, "requested_changes" | "reviewed"> = {
  approve: "reviewed",
  "request-changes": "requested_changes",
  comment: "reviewed",
};

/**
 * The reviewer states that confirm an Approve or a Comment went through: an approval moves the state
 * the publish set on to `approved` on a GitLab that tracks it, and leaves it `reviewed` otherwise.
 */
const CONFIRMING_STATES: Record<Exclude<Verdict, "request-changes">, readonly [string, ...string[]]> = {
  approve: ["approved", "reviewed"],
  comment: ["reviewed"],
};

/** A reviewer state as a sentence names it: "GitLab lists you as …". */
function describeState(state: string | null): string {
  switch (state) {
    case null:
      return "with no reviewer state";
    case "requested_changes":
      return "requesting changes";
    case "unreviewed":
      return "not reviewed yet";
    case "review_started":
      return "reviewing";
    default:
      return state.replaceAll("_", " ");
  }
}

export type GitLabForgeOptions = {
  run: CommandRunner;
  /** The `glab` executable from the settings. */
  glab: () => Promise<string>;
};

/**
 * The GitLab adapter, over `glab api`. It addresses a project by its numeric ID, looked up once per
 * path, because some GitLab versions turn down a URL-encoded path on the draft notes endpoints.
 *
 * `glab` is only ever pointed at a host it is logged in to: given any other, it sends whatever token
 * it has there. So every host is checked with `glab auth status` before its first call.
 */
export function createGitLabForge(options: GitLabForgeOptions): Forge {
  const glab = createCli({ run: options.run, binary: options.glab, name: "glab", env: GLAB_ENV, unsetEnv: GLAB_UNSET_ENV });
  const hosts = new Map<string, Promise<void>>();
  const projectIds = new Map<string, Promise<number>>();
  const versions = new Map<string, Promise<string>>();

  /** Resolves once `glab` is known to be logged in to `host`; a failed check is asked again next time. */
  const loggedIn = (host: string) => remember(hosts, host, () => checkLogin(glab, host));

  const api = async <Schema extends z.ZodType>(repository: RepositoryRef, schema: Schema, path: string) => {
    await loggedIn(repository.host);
    return glab.json(schema, ["api", "--hostname", repository.host, path]);
  };

  const projectId = (repository: RepositoryRef) =>
    remember(projectIds, `${repository.host}/${repository.project.toLowerCase()}`, async () => {
      const project = await api(repository, ProjectResponse, `projects/${encodeURIComponent(repository.project)}`);
      return project.id;
    });

  /** Every document a paginated list has, read one per line: `--paginate` alone prints each page as its own array. */
  const list = async <Schema extends z.ZodType>(repository: RepositoryRef, schema: Schema, path: string) => {
    await loggedIn(repository.host);
    return glab.ndjson(schema, ["api", "--hostname", repository.host, path, "--paginate", "--output", "ndjson"]);
  };

  /**
   * A write, its body as JSON on stdin with the content type said outright: without it GitLab reads
   * the body as a form and drops a draft's position, and bracketed form fields drop it as well.
   */
  const send = async <Schema extends z.ZodType>(
    repository: RepositoryRef,
    schema: Schema,
    method: "POST" | "PUT",
    path: string,
    body: Record<string, unknown>,
  ) => {
    await loggedIn(repository.host);
    return glab.json(
      schema,
      ["api", "--hostname", repository.host, "--method", method, "--header", "Content-Type: application/json", "--input", "-", path],
      { input: JSON.stringify(body) },
    );
  };

  const listingOn = async (host: string): Promise<Omit<ListedHost, "error">> => {
    const { version } = await glab.json(VersionResponse, ["api", "--hostname", host, "version"]);
    if (!isAtLeast(version, REVIEW_LIST_VERSION)) {
      throw new ForgeError(`${host} runs GitLab ${version}; listing your reviews needs ${REVIEW_LIST_VERSION.join(".")} or newer.`);
    }
    const response = await glab.json(ReviewListResponse, ["api", "graphql", "--hostname", host, "-f", `query=${REVIEW_LIST_QUERY}`]);
    const user = response.data?.currentUser;
    if (!user) {
      throw new ForgeError(`GitLab on ${host} did not list your reviews: ${response.errors?.[0]?.message ?? "no current user"}.`);
    }
    const { reviewRequestedMergeRequests: assigned, authoredMergeRequests: authored } = user;
    return {
      forge: "gitlab",
      host,
      assigned: assigned.nodes.map((mr) => reviewRequestOf(mr, user.username)).filter((request) => request !== null),
      authored: authored.nodes.map(authoredOf).filter((request) => request !== null),
      truncated: { assigned: assigned.pageInfo.hasNextPage, authored: authored.pageInfo.hasNextPage },
    };
  };

  const draftNotes = async (ref: ChangeRequestRef) => `projects/${await projectId(ref)}/merge_requests/${ref.number}/draft_notes`;

  const deleteDraftNote = async (ref: ChangeRequestRef, id: string) => {
    await loggedIn(ref.host);
    // GitLab answers 204 with no body.
    await glab.text(["api", "--hostname", ref.host, "--method", "DELETE", `${await draftNotes(ref)}/${id}`]);
  };

  const mergeRequest = async (ref: ChangeRequestRef) => `projects/${await projectId(ref)}/merge_requests/${ref.number}`;

  /** A `POST` whose answer is not read, like `bulk_publish`'s empty 204, sent as JSON the way `send` sends one. */
  const post = async (ref: ChangeRequestRef, path: string, body: Record<string, unknown>) => {
    await loggedIn(ref.host);
    await glab.text(
      ["api", "--hostname", ref.host, "--method", "POST", "--header", "Content-Type: application/json", "--input", "-", path],
      { input: JSON.stringify(body) },
    );
  };

  /**
   * Whether this GitLab's `bulk_publish` takes the review body as `note`. One older than 19.2
   * publishes the drafts and silently drops it, and one whose version cannot be read is taken for
   * such: the body then goes as an MR note of its own, which is what a newer GitLab makes of it too.
   */
  const publishesBody = async (ref: ChangeRequestRef): Promise<boolean> => {
    try {
      const { version } = await api(ref, VersionResponse, "version");
      return isAtLeast(version, BULK_PUBLISH_BODY_VERSION);
    } catch {
      return false;
    }
  };

  /**
   * The viewer's reviewer state from the MR's reviewer list: undefined when the viewer is not one of
   * its reviewers, whom GitLab keeps no state for, and null when GitLab gives a reviewer none.
   */
  const viewerState = async (ref: ChangeRequestRef): Promise<string | null | undefined> => {
    const viewer = (await api(ref, UserResponse, "user")).username.toLowerCase();
    const reviewers = await api(ref, ReviewersResponse, `${await mergeRequest(ref)}/reviewers`);
    const own = reviewers.find((reviewer) => reviewer.user.username.toLowerCase() === viewer);
    return own === undefined ? undefined : (own.state ?? null);
  };

  /**
   * Confirms in the reviewer list that an Approve or a Comment left the viewer's state where it
   * should be: an older GitLab ignores `reviewer_state`, and a newer one does not say whether setting
   * it worked. Nothing is set here; a state that did not take is reported for the reviewer to set.
   * Returns the note the step reports: a viewer who is not a reviewer has no state, which is not a failure.
   */
  const confirmState = async (ref: ChangeRequestRef, verdict: Exclude<Verdict, "request-changes">): Promise<string | null> => {
    let state: string | null | undefined;
    try {
      state = await viewerState(ref);
    } catch (error) {
      throw new ForgeError(`Could not read the merge request's reviewers to confirm your state: ${(error as Error).message}`);
    }
    if (state === undefined) return "You are not one of the merge request's reviewers, so GitLab keeps no reviewer state for you.";
    const expected = CONFIRMING_STATES[verdict];
    if (state !== null && expected.includes(state)) return null;
    throw new ForgeError(
      `GitLab lists you as ${describeState(state)}, not ${describeState(expected[0])}. Set your reviewer state on the merge request's page.`,
    );
  };

  /**
   * Makes the viewer's reviewer state Requested changes where the bulk publish did not. The reviewer
   * list says whether it took, and the GraphQL mutation sets it when it did not or when the list
   * cannot be read. The mutation fails as HTTP 200 with `errors`, which are read here.
   */
  const requestChanges = async (ref: ChangeRequestRef) => {
    const took = await viewerState(ref).then(
      (state) => state === "requested_changes",
      () => false,
    );
    if (took) return;

    await loggedIn(ref.host);
    const response = await glab.json(RequestChangesResponse, [
      "api",
      "--hostname",
      ref.host,
      "graphql",
      "-f",
      `query=${REQUEST_CHANGES_MUTATION}`,
      "-f",
      `projectPath=${ref.project}`,
      "-f",
      `iid=${ref.number}`,
    ]);
    const payload = response.data?.mergeRequestRequestChanges;
    const errors = [...(response.errors ?? []).map((error) => error.message), ...(payload?.errors ?? [])];
    if (errors.length === 0 && !payload) errors.push("it answered with no result");
    if (errors.length > 0) {
      throw new ForgeError(`GitLab did not record your request for changes: ${errors.join("; ")}. Request changes on the merge request's page.`);
    }
  };

  return {
    kind: "gitlab",
    urlHint: "a GitLab merge request URL on a host glab is logged in to, like https://gitlab.com/group/project/-/merge_requests/123",

    async matchUrl(url) {
      const ref = parseMergeRequestUrl(url);
      if (ref !== null) await loggedIn(ref.host);
      return ref;
    },

    async findByBranch(remote, branch): Promise<BranchChangeRequest[] | null> {
      // Any host but GitHub's may be a GitLab, as with a URL; one glab is not logged in to fails the check.
      const host = remote.host.toLowerCase();
      if (host.replace(/^www\./, "") === GITHUB_HOST) return null;
      const repository = { host, project: remote.project };
      const query = new URLSearchParams({ source_branch: branch, state: "opened", per_page: String(MAX_BRANCH_CHANGE_REQUESTS) });
      const mergeRequests = await api(
        repository,
        BranchMergeRequestsResponse,
        `projects/${await projectId(repository)}/merge_requests?${query}`,
      );
      return mergeRequests.flatMap((mr) => {
        const ref = parseMergeRequestUrl(mr.web_url);
        return ref === null ? [] : [{ ref, title: mr.title, author: userOf(mr.author && { login: mr.author.username }).login, headSha: mr.sha }];
      });
    },

    async fetchChangeRequest(ref) {
      const path = `projects/${await projectId(ref)}/merge_requests/${ref.number}`;
      const mr = await api(ref, MergeRequestResponse, path);
      if (mr.diff_refs === null) throw new ForgeError(`GitLab has not worked out the diff of ${ref.url} yet. Try again in a moment.`);

      // `--paginate` prints each page as its own array, one after the other; one document per line
      // is the output that reads back whole.
      const diffs = await glab.ndjson(DiffEntry, [
        "api",
        "--hostname",
        ref.host,
        `${path}/diffs?per_page=100`,
        "--paginate",
        "--output",
        "ndjson",
      ]);
      const commits = await api(ref, CommitsResponse, `${path}/commits?per_page=${MAX_COMMITS}`);
      const issues = await api(ref, ClosesIssuesResponse, `${path}/closes_issues?per_page=${MAX_LINKED_ISSUES}`);

      const files = diffs.map(changedFile);
      return {
        ref,
        title: mr.title,
        description: mr.description ?? "",
        author: userOf(mr.author && { login: mr.author.username, name: mr.author.name }),
        state: STATES[mr.state],
        isDraft: mr.draft ?? mr.work_in_progress ?? false,
        baseBranch: mr.target_branch,
        headBranch: mr.source_branch,
        baseSha: mr.diff_refs.base_sha,
        startSha: mr.diff_refs.start_sha,
        headSha: mr.diff_refs.head_sha,
        // GitLab's REST API has no line counts, so they are the diffs' own, which a withheld diff adds nothing to.
        additions: sum(files, "additions"),
        deletions: sum(files, "deletions"),
        // Newest first from GitLab; oldest first, as on GitHub, is the order they were written in.
        commits: [...commits].reverse().map((commit) => ({
          sha: commit.id,
          headline: commit.title,
          body: commit.message.replace(/\r\n/g, "\n").split("\n").slice(1).join("\n").trim(),
          author: commit.author_name,
          authoredAt: commit.authored_date,
          parents: commit.parent_ids,
        })),
        linkedIssues: issues.flatMap((issue) =>
          issue.iid === undefined || issue.web_url === undefined
            ? []
            : [{ number: issue.iid, url: issue.web_url, title: issue.title ?? "", body: issue.description ?? "", state: issue.state ?? "" }],
        ),
        files,
      } satisfies ChangeRequest;
    },

    async fetchHead(ref): Promise<ChangeRequestHead> {
      const mr = await api(ref, MergeRequestHeadResponse, `projects/${await projectId(ref)}/merge_requests/${ref.number}`);
      // The diff's head, which is what `fetchChangeRequest` reads, so a push shows once a new read would see it.
      const headSha = mr.diff_refs?.head_sha ?? mr.sha;
      if (headSha === null) throw new ForgeError(`GitLab has not worked out the diff of ${ref.url} yet. Try again in a moment.`);
      return { headSha, state: STATES[mr.state], description: mr.description ?? "" };
    },

    async fetchAttachment(ref, url, maxBytes) {
      const upload = uploadOf(ref, url);
      if (upload === null) return null;
      const version = await remember(versions, ref.host, async () => (await api(ref, VersionResponse, "version")).version);
      if (!isAtLeast(version, UPLOAD_DOWNLOAD_VERSION)) {
        throw new ForgeError(`${ref.host} runs GitLab ${version}; showing an uploaded image here needs ${UPLOAD_DOWNLOAD_VERSION.join(".")} or newer.`);
      }
      const project = upload.projectId ?? (await projectId(ref));
      return glab.bytes(["api", "--hostname", ref.host, `projects/${project}/uploads/${upload.secret}/${encodeURIComponent(upload.filename)}`], { maxBytes });
    },

    async commitsSince(ref, sha) {
      // Newest first; a page shorter than asked for is all of them.
      const commits = await api(ref, CommitIdsResponse, `${await mergeRequest(ref)}/commits?per_page=${COMMITS_SINCE_PAGE}`);
      return commitsSinceIn(commits.map((commit) => commit.id), sha, commits.length < COMMITS_SINCE_PAGE);
    },

    async commitChangeRequests(ref, shas) {
      const commits = `projects/${await projectId(ref)}/repository/commits`;
      const listed = await mapAtMost(shas, COMMIT_READS_AT_ONCE, async (sha) => {
        const mergeRequests = await api(ref, CommitMergeRequestsResponse, `${commits}/${sha}/merge_requests`);
        return [sha, mergeRequests.map(commitMergeRequest)] as const;
      });
      return new Map(listed);
    },

    async changedPaths(ref, from, to) {
      const query = new URLSearchParams({ from, to, straight: "true" });
      const compare = await api(ref, CompareResponse, `projects/${await projectId(ref)}/repository/compare?${query}`);
      if (compare.compare_timeout) return null;
      return [...new Set(compare.diffs.flatMap((diff) => [diff.old_path, diff.new_path]))];
    },

    async currentUser(ref): Promise<ForgeUser> {
      const user = await api(ref, UserResponse, "user");
      return { login: user.username, name: user.name ?? null };
    },

    async cloneRepository(ref, directory) {
      await loggedIn(ref.host);
      // glab picks the protocol and credentials the reviewer set it up with, which `git clone` would not.
      await glab.text(["repo", "clone", `https://${ref.host}/${ref.project}`, directory], { timeoutMs: CLONE_TIMEOUT_MS });
    },

    /**
     * The viewer's draft notes, which GitLab keeps to their author. A reply to a published thread
     * sits where the thread does, so the MR's discussions are read when there is one. A draft with
     * no place in the diff, on the MR as a whole or a reply to a thread that is, is `general`.
     */
    async listDrafts(ref) {
      const notes = await list(ref, DraftNoteResponse, `${await draftNotes(ref)}?per_page=100`);
      const replies = notes.filter((note) => locationOf(note.position) === null && note.discussion_id);
      const threads = new Map<string, Position | null | undefined>();
      if (replies.length > 0) {
        const path = `projects/${await projectId(ref)}/merge_requests/${ref.number}/discussions?per_page=100`;
        for (const discussion of await list(ref, DiscussionResponse, path)) threads.set(discussion.id, discussion.notes[0]?.position);
      }
      return notes.flatMap((note) => {
        const location = locationOf(note.position) ?? (note.discussion_id ? locationOf(threads.get(note.discussion_id)) : null);
        return [{ id: String(note.id), body: note.note, location: location ?? { kind: "general" } }];
      });
    },

    /**
     * A draft note at the anchor's position. GitLab can take a position and keep another, or none,
     * without an error, so the one it answers with is checked against the one sent, and a draft
     * that did not land where it was put is deleted again rather than left in the wrong place.
     * A `general` draft is sent with no position, an MR-level draft note, its own thread once published.
     */
    async createDraft(target, { anchor, body }): Promise<Draft> {
      const { ref } = target;
      if (anchor.kind === "general") {
        const created = await send(ref, DraftNoteResponse, "POST", await draftNotes(ref), { note: body });
        return { id: String(created.id), body: created.note, location: { kind: "general" } };
      }
      const position = positionOf(target, anchor);
      const created = await send(ref, DraftNoteResponse, "POST", await draftNotes(ref), { note: body, position });
      const location = samePosition(position, created.position) ? locationOf(created.position) : null;
      if (location !== null) return { id: String(created.id), body: created.note, location };

      try {
        await deleteDraftNote(ref, String(created.id));
      } catch (error) {
        throw new ForgeError(
          `GitLab did not keep the comment where it was put, and deleting the misplaced draft failed too (${(error as Error).message}). Delete it on the merge request's page before submitting.`,
        );
      }
      throw new ForgeError("GitLab did not keep the comment where it was put, so the draft was deleted again. This GitLab may not take comments of this kind.");
    },

    /**
     * An edit sets the position to whatever it is sent, none included, so the draft's own is read
     * first and sent back with the new text.
     */
    async updateDraft(ref, draftId, body) {
      const id = draftNoteId(draftId);
      const path = `${await draftNotes(ref)}/${id}`;
      const current = await api(ref, DraftNoteResponse, path);
      const position = locationOf(current.position) === null ? {} : { position: current.position };
      await send(ref, DraftNoteResponse, "PUT", path, { note: body, ...position });
    },

    async deleteDraft(ref, draftId) {
      await deleteDraftNote(ref, draftNoteId(draftId));
    },

    takesGeneralDrafts: true,

    async postComment(ref, body) {
      await post(ref, `${await mergeRequest(ref)}/notes`, { body });
    },

    async startDiscussion(ref, body) {
      await post(ref, `${await mergeRequest(ref)}/discussions`, { body });
    },

    /**
     * Publishes every draft note at once with `bulk_publish`, the body as its `note` and the verdict
     * as its `reviewer_state` (`requested_changes`, else `reviewed`). A GitLab older than 19.2 drops
     * both, so there the body is posted as an MR note of its own. An approval is the approve endpoint
     * after, on `approveHeadSha`, which GitLab refuses once the MR has moved past it. Every verdict ends with
     * the reviewer list read for the viewer's state: an Approve or a Comment reports what it found as a
     * step of its own, and a request for changes that did not take is set through GraphQL. Nothing
     * after a failed publish is tried, so no verdict goes out without the comments it was given with.
     */
    async submitReview(target, { verdict, body, approveHeadSha }): Promise<SubmitOutcome> {
      const { ref } = target;
      const steps = new SubmitSteps();
      const withNote = body !== "" && (await publishesBody(ref));
      const separateNote = body !== "" && !withNote;
      const notTried = "Not tried, since your drafts were not published.";

      const publish = await steps.run("publish", withNote ? "Publish your drafts and the review body" : "Publish your drafts", async () =>
        post(ref, `${await draftNotes(ref)}/bulk_publish`, { ...(withNote ? { note: body } : {}), reviewer_state: REVIEWER_STATES[verdict] }),
      );

      let bodyOut = !separateNote;
      if (separateNote) {
        const label = "Post the review body";
        if (publish.ok) bodyOut = (await steps.run("note", label, async () => post(ref, `${await mergeRequest(ref)}/notes`, { body }))).ok;
        else steps.skip("note", label, notTried);
      }

      if (verdict === "approve") {
        if (!publish.ok) steps.skip("approve", "Approve", notTried);
        else {
          await steps.run("approve", "Approve", async () => {
            try {
              // GitLab answers 409 when the MR's head is not `sha`.
              await post(ref, `${await mergeRequest(ref)}/approve`, approveHeadSha === null ? {} : { sha: approveHeadSha });
            } catch (error) {
              if (error instanceof ForgeError && /HTTP 409/.test(error.message)) {
                throw new ForgeError("GitLab did not approve, as the MR got new commits while your review was being submitted. Open Finish review again to see them and approve.");
              }
              throw error;
            }
          });
        }
      }

      if (verdict === "request-changes") {
        if (publish.ok) await steps.run("request-changes", "Request changes", () => requestChanges(ref));
        else steps.skip("request-changes", "Request changes", notTried);
      } else {
        const label = "Confirm your reviewer state";
        if (publish.ok) await steps.run("reviewer-state", label, () => confirmState(ref, verdict), (note) => note);
        else steps.skip("reviewer-state", label, notTried);
      }

      return { published: publish.ok && bodyOut, steps: steps.steps };
    },

    /**
     * Deletes every one of the viewer's draft notes, MR-level ones included, one by one, since GitLab
     * has no bulk delete. Each is tried whatever became of the one before, and any left are named.
     */
    async discardReview(ref) {
      const notes = await list(ref, DraftNoteResponse, `${await draftNotes(ref)}?per_page=100`);
      const failures: string[] = [];
      for (const note of notes) {
        try {
          await deleteDraftNote(ref, draftNoteId(String(note.id)));
        } catch (error) {
          failures.push(`${note.id} (${(error as Error).message})`);
        }
      }
      if (failures.length > 0) {
        const count = failures.length === 1 ? "One of your draft notes" : `${failures.length} of your draft notes`;
        throw new ForgeError(`${count} could not be deleted: ${failures.join(", ")}. Delete what is left on the merge request's page.`);
      }
    },

    async listChangeRequests(): Promise<ListedHost[]> {
      const statuses = parseAuthStatus(await glab.report(["auth", "status", "--all"]));
      return Promise.all(
        statuses.map(async ({ host, loggedIn, problem }): Promise<ListedHost> => {
          if (!loggedIn) {
            const reason = problem === null ? "" : ` (${problem})`;
            return unlistedHost("gitlab", host, `glab is not logged in to ${host}${reason}. Run \`glab auth login --hostname ${host}\` on the daemon's host.`);
          }
          hosts.set(host, Promise.resolve());
          try {
            return { ...(await listingOn(host)), error: null };
          } catch (error) {
            if (!(error instanceof ForgeError)) throw error;
            return unlistedHost("gitlab", host, error.message);
          }
        }),
      );
    },
  };
}

/** A draft's ID as it goes in a path: GitLab's are numbers, and anything else would name another endpoint. */
function draftNoteId(draftId: string): string {
  if (!/^[1-9]\d{0,18}$/.test(draftId)) throw new ForgeError(`${draftId} is not a GitLab draft note.`);
  return draftId;
}

/**
 * Where a draft note goes, from the MR's diff refs: a line as a `text` position with `new_line` for
 * an added line, `old_line` for a removed one and both for an unchanged one; a range as its last
 * line plus a `line_range` whose ends carry their `line_code`s; a file as a `file` position.
 */
function positionOf(target: DraftTarget, anchor: Exclude<DraftAnchor, { kind: "general" }>): Record<string, unknown> {
  const base = {
    base_sha: target.baseSha,
    start_sha: target.startSha,
    head_sha: target.headSha,
    old_path: anchor.previousPath ?? anchor.path,
    new_path: anchor.path,
  };
  switch (anchor.kind) {
    case "file":
      return { position_type: "file", ...base };
    case "line":
      return { position_type: "text", ...base, ...lineNumbers(anchor.line) };
    case "range":
      return {
        position_type: "text",
        ...base,
        ...lineNumbers(anchor.end),
        line_range: { start: rangeEnd(anchor.path, anchor.start), end: rangeEnd(anchor.path, anchor.end) },
      };
  }
}

function lineNumbers(line: AnchorLine): { old_line?: number; new_line?: number } {
  switch (line.kind) {
    case "added":
      return { new_line: line.newLine! };
    case "removed":
      return { old_line: line.oldLine! };
    case "context":
      return { old_line: line.oldLine!, new_line: line.newLine! };
  }
}

/**
 * One end of a range. Its `line_code` is the path's SHA-1 and GitLab's running counters at the line,
 * `path` being the file's new path, or its old one for a deleted file, as the anchor's path is.
 */
function rangeEnd(path: string, line: AnchorLine) {
  return {
    line_code: lineCode(path, line),
    type: line.kind === "added" ? "new" : line.kind === "removed" ? "old" : null,
    old_line: line.oldLine,
    new_line: line.newLine,
  };
}

function lineCode(path: string, line: Pick<AnchorLine, "oldPos" | "newPos">): string {
  return `${createHash("sha1").update(path).digest("hex")}_${line.oldPos}_${line.newPos}`;
}

const COMPARED = ["position_type", "base_sha", "start_sha", "head_sha", "old_path", "new_path", "old_line", "new_line"] as const;

/** Whether GitLab kept the position it was sent: the same place, and a range's ends by their line codes. */
function samePosition(sent: Record<string, unknown>, kept: Position | null | undefined): boolean {
  if (!kept) return false;
  if (!COMPARED.every((key) => (sent[key] ?? null) === (kept[key] ?? null))) return false;
  const range = sent.line_range as { start: { line_code: string }; end: { line_code: string } } | undefined;
  if (range === undefined) return true;
  return kept.line_range?.start.line_code === range.start.line_code && kept.line_range?.end.line_code === range.end.line_code;
}

/**
 * A position as a `DraftLocation`, or null for one on no file: an MR-level draft, whose position is
 * missing or all null. The last line is the top-level one; a range's first is its `line_range` start.
 */
function locationOf(position: Position | null | undefined): DraftLocation | null {
  const path = position?.new_path ?? position?.old_path;
  if (!position || !path) return null;
  const end = lineRef(position.new_line, position.old_line);
  if (position.position_type !== "text" || end === null) return { kind: "file", path };
  const start = position.line_range ? rangeEndRef(position.line_range.start) : null;
  if (start === null || (start.side === end.side && start.line === end.line)) return { kind: "line", path, line: end };
  return { kind: "range", path, start, end };
}

/** An unchanged line is named by its new number, as `lineRefOf` names it. */
function lineRef(newLine: number | null | undefined, oldLine: number | null | undefined): LineRef | null {
  if (newLine != null) return { side: "new", line: newLine };
  if (oldLine != null) return { side: "old", line: oldLine };
  return null;
}

/** A range end by its numbers, or by its `line_code`'s counters, which equal them on the side it is on. */
function rangeEndRef(end: z.output<typeof LineRangeEnd>): LineRef | null {
  const counters = /_(\d+)_(\d+)$/.exec(end.line_code ?? "");
  const oldLine = end.old_line ?? (counters ? Number(counters[1]) : null);
  const newLine = end.new_line ?? (counters ? Number(counters[2]) : null);
  if (end.type === "old") return lineRef(null, oldLine);
  return lineRef(newLine, oldLine);
}

async function checkLogin(glab: Cli, host: string): Promise<void> {
  if (await glab.succeeds(["auth", "status", "--hostname", host])) return;
  throw new ForgeError(`glab is not logged in to ${host}. Run \`glab auth login --hostname ${host}\` on the daemon's host.`);
}

/** The promise `create` makes for `key`, made once while it holds and again after it fails. */
function remember<T>(cache: Map<string, Promise<T>>, key: string, create: () => Promise<T>): Promise<T> {
  const cached = cache.get(key);
  if (cached !== undefined) return cached;
  const created = create();
  cache.set(key, created);
  created.catch(() => {
    if (cache.get(key) === created) cache.delete(key);
  });
  return created;
}

function commitMergeRequest(mr: z.output<typeof CommitMergeRequestsResponse>[number]): CommitChangeRequest {
  return { number: mr.iid, url: mr.web_url, title: mr.title, state: STATES[mr.state], sourceBranch: mr.source_branch, targetBranch: mr.target_branch };
}

function changedFile(entry: z.output<typeof DiffEntry>): ChangedFile {
  // GitLab's diff starts at the first `@@` like GitHub's patch, but ends in a newline GitHub's does not.
  const patch = entry.diff.startsWith("@@") ? entry.diff.replace(/\n$/, "") : null;
  let additions = 0;
  let deletions = 0;
  // Without the file header, every line starting with `+` or `-` is a changed line.
  for (const line of patch?.split("\n") ?? []) {
    if (line.startsWith("+")) additions += 1;
    else if (line.startsWith("-")) deletions += 1;
  }
  return {
    path: entry.deleted_file ? entry.old_path : entry.new_path,
    previousPath: entry.renamed_file ? entry.old_path : null,
    status: entry.new_file ? "added" : entry.deleted_file ? "removed" : entry.renamed_file ? "renamed" : "modified",
    additions,
    deletions,
    patch,
  };
}

function sum(files: readonly ChangedFile[], field: "additions" | "deletions"): number {
  return files.reduce((total, file) => total + file[field], 0);
}

/** `locked` is an MR in the middle of being merged, which has not happened yet. */
const STATES: Record<"opened" | "closed" | "locked" | "merged", ChangeRequestState> = {
  opened: "open",
  closed: "closed",
  locked: "open",
  merged: "merged",
};

const SEGMENT = /^[A-Za-z0-9_][A-Za-z0-9_.-]*$/;

/**
 * A merge request URL on any host but github.com, with or without its scheme and with whatever tab
 * or anchor it was copied from; anything else is null. The project path is everything before the
 * `/-/`, subgroups included. Whether `glab` can reach the host is a separate question.
 */
/**
 * The upload a description's link names: `/<project>/uploads/<secret>/<file>` as the Markdown has it,
 * or `/-/project/<id>/uploads/…` as newer GitLab renders it. Null for any other URL.
 */
export function uploadOf(ref: ChangeRequestRef, url: string): { projectId: number | null; secret: string; filename: string } | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== "https:" || parsed.hostname !== ref.host) return null;
  const match = /^\/(?:-\/project\/(\d+)|(.+))\/uploads\/([0-9a-f]+)\/([^/]+)$/.exec(parsed.pathname);
  if (match === null) return null;
  const [, id, project, secret, filename] = match;
  if (project !== undefined && project.toLowerCase() !== ref.project.toLowerCase()) return null;
  try {
    return { projectId: id === undefined ? null : Number(id), secret: secret!, filename: decodeURIComponent(filename!) };
  } catch {
    return null;
  }
}

export function parseMergeRequestUrl(text: string): ChangeRequestRef | null {
  const trimmed = text.trim();
  let url: URL;
  try {
    url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  // `glab --hostname` takes a host without its port; one on a port is set up in glab's own config.
  const host = url.hostname.toLowerCase();
  if (host === "" || host.replace(/^www\./, "") === GITHUB_HOST) return null;

  const segments = url.pathname.split("/").filter((segment) => segment !== "");
  const dash = segments.indexOf("-");
  if (dash < 2 || segments[dash + 1] !== "merge_requests") return null;
  const number = segments[dash + 2];
  if (number === undefined || !/^[1-9]\d{0,9}$/.test(number)) return null;
  const path = segments.slice(0, dash);
  if (!path.every((segment) => SEGMENT.test(segment))) return null;

  const project = path.join("/");
  return {
    forge: "gitlab",
    host,
    project,
    number: Number(number),
    url: `${url.protocol}//${url.host.toLowerCase()}/${project}/-/merge_requests/${number}`,
  };
}
