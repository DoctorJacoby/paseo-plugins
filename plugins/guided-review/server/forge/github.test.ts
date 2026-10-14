import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fakeCommandRunner, type FakeCommandRunner, type ScriptedResult } from "../fake-command-runner.ts";
import { CliNotFoundError } from "./cli.ts";
import {
  ADD_THREAD_MUTATION,
  AUTHORED_SEARCH_QUERY,
  COMMIT_PULL_REQUESTS_QUERY,
  createGitHubForge,
  MAX_COMPARE_FILES,
  isAttachmentUrl,
  DELETE_COMMENT_MUTATION,
  DELETE_REVIEW_MUTATION,
  DRAFTS_QUERY,
  PENDING_REVIEW_QUERY,
  PULL_REQUEST_COMMITS_QUERY,
  PULL_REQUEST_HEAD_QUERY,
  PULL_REQUEST_QUERY,
  REVIEW_SEARCH_QUERY,
  REVIEW_SEARCHES,
  START_REVIEW_MUTATION,
  SUBMIT_REVIEW_MUTATION,
  UPDATE_COMMENT_MUTATION,
} from "./github.ts";
import { ForgeError, type AnchorLine, type ChangeRequestRef, type DraftAnchor, type DraftTarget } from "./port.ts";

/** Recorded from `gh` 2.101 against sleeyax/paseo-plugins#105; the user is trimmed to its public fields. */
function fixture(name: string): string {
  return readFileSync(path.join(import.meta.dirname, "fixtures", "github", name), "utf8");
}

const GH = "/opt/gh/bin/gh";

function forgeReplaying(script: readonly ScriptedResult[]) {
  const run = fakeCommandRunner(script);
  return { run, forge: createGitHubForge({ run, gh: async () => GH }) };
}

const PR_105: ChangeRequestRef = {
  forge: "github",
  host: "github.com",
  project: "sleeyax/paseo-plugins",
  number: 105,
  url: "https://github.com/sleeyax/paseo-plugins/pull/105",
};

test("takes a pull request URL however it was copied", async () => {
  const { forge } = forgeReplaying([]);
  for (const url of [
    "https://github.com/sleeyax/paseo-plugins/pull/105",
    "  https://github.com/sleeyax/paseo-plugins/pull/105/files  ",
    "https://www.github.com/sleeyax/paseo-plugins/pull/105#discussion_r1",
    "http://github.com/sleeyax/paseo-plugins/pull/105?w=1",
    "github.com/sleeyax/paseo-plugins/pull/105",
  ]) {
    assert.deepEqual(await forge.matchUrl(url), PR_105, url);
  }
});

test("turns down anything that is not a GitHub pull request", async () => {
  const { forge, run } = forgeReplaying([]);
  for (const url of [
    "",
    "not a url",
    "https://github.com/sleeyax/paseo-plugins",
    "https://github.com/sleeyax/paseo-plugins/issues/90",
    "https://github.com/sleeyax/paseo-plugins/pulls",
    "https://github.com/sleeyax/paseo-plugins/pull/0",
    "https://github.com/sleeyax/paseo-plugins/pull/abc",
    "https://github.com/../etc/pull/1",
    "https://gitlab.com/group/project/-/merge_requests/1",
    "https://example.com/sleeyax/paseo-plugins/pull/105",
    "ftp://github.com/sleeyax/paseo-plugins/pull/105",
  ]) {
    assert.equal(await forge.matchUrl(url), null, url);
  }
  assert.deepEqual(run.calls, [], "matching a URL runs nothing");
});

test("reads a pull request's metadata, commits, linked issues and files through gh", async () => {
  const { forge, run } = forgeReplaying([{ stdout: fixture("pull-request.json") }, { stdout: fixture("files.json") }]);

  const pr = await forge.fetchChangeRequest(PR_105);

  assert.deepEqual(
    run.calls.map((call) => ({ file: call.file, args: call.args, input: call.input && JSON.parse(call.input) })),
    [
      {
        file: GH,
        args: ["api", "graphql", "--hostname", "github.com", "--input", "-"],
        input: { query: PULL_REQUEST_QUERY, variables: { owner: "sleeyax", name: "paseo-plugins", number: 105 } },
      },
      {
        file: GH,
        args: ["api", "--hostname", "github.com", "repos/sleeyax/paseo-plugins/pulls/105/files?per_page=100", "--paginate"],
        input: undefined,
      },
    ],
  );
  for (const call of run.calls) assert.equal(call.env?.GH_PROMPT_DISABLED, "1");

  assert.equal(pr.ref, PR_105);
  assert.equal(pr.title, "chore: build the plugins against Paseo SDK 0.9.2");
  assert.match(pr.description, /^Closes #89\./);
  assert.deepEqual(pr.author, { login: "sleeyax", name: "Sleeyax" });
  assert.equal(pr.state, "merged");
  assert.equal(pr.isDraft, false);
  assert.deepEqual(
    { baseBranch: pr.baseBranch, headBranch: pr.headBranch, baseSha: pr.baseSha, startSha: pr.startSha, headSha: pr.headSha },
    {
      baseBranch: "main",
      headBranch: "chore/paseo-sdk-0.9.2",
      baseSha: "41ff25de85931953ace4daa1a7923e20823514c5",
      startSha: "41ff25de85931953ace4daa1a7923e20823514c5",
      headSha: "a711a639b04f3bd2bfe514157e0c19880fe33028",
    },
  );
  assert.deepEqual({ additions: pr.additions, deletions: pr.deletions }, { additions: 63, deletions: 43 });

  assert.equal(pr.commits.length, 3);
  assert.equal(pr.commits[0]?.author, "sleeyax");
  assert.match(pr.commits[0]?.sha ?? "", /^[0-9a-f]{40}$/);
  assert.deepEqual(pr.commits[0]?.parents, [pr.baseSha]);

  assert.deepEqual(
    pr.linkedIssues.map(({ number, title, state }) => ({ number, title, state })),
    [{ number: 89, title: "Bump the Paseo SDK to 0.9.2 across the workspace", state: "CLOSED" }],
  );

  assert.deepEqual(
    pr.files.map(({ path, status, additions, deletions }) => ({ path, status, additions, deletions })),
    [
      { path: "apps/claude-tty-acp/src/claude-runtime.test.ts", status: "modified", additions: 29, deletions: 9 },
      { path: "plugins/catppuccin-theme/package.json", status: "modified", additions: 1, deletions: 1 },
      { path: "plugins/claude-tty/CLAUDE.md", status: "modified", additions: 1, deletions: 1 },
      { path: "plugins/claude-tty/package.json", status: "modified", additions: 2, deletions: 2 },
      { path: "plugins/discord-rich-presence/package.json", status: "modified", additions: 2, deletions: 2 },
      { path: "pnpm-lock.yaml", status: "modified", additions: 28, deletions: 28 },
    ],
  );
  assert.match(pr.files[1]?.patch ?? "", /^@@ -8,7 \+8,7 @@/);
});

test("keeps where a renamed file came from, and that a binary file has no patch", async () => {
  const files = [
    ...JSON.parse(fixture("files.json")),
    { filename: "docs/logo.png", previous_filename: "logo.png", status: "renamed", additions: 0, deletions: 0 },
  ];
  const { forge } = forgeReplaying([{ stdout: fixture("pull-request.json") }, { stdout: JSON.stringify(files) }]);

  const pr = await forge.fetchChangeRequest(PR_105);

  assert.deepEqual(pr.files.at(-1), {
    path: "docs/logo.png",
    previousPath: "logo.png",
    status: "renamed",
    additions: 0,
    deletions: 0,
    patch: null,
  });
});

test("a pull request gh cannot find fails in gh's own words", async () => {
  const { forge, run } = forgeReplaying([
    {
      exitCode: 1,
      stdout: fixture("pull-request-missing.json"),
      stderr: "gh: Could not resolve to a PullRequest with the number of 999999.\n",
    },
  ]);

  await assert.rejects(
    forge.fetchChangeRequest({ ...PR_105, number: 999999 }),
    new ForgeError("gh failed: Could not resolve to a PullRequest with the number of 999999."),
  );
  assert.equal(run.calls.length, 1, "the file list is not asked for");
});

test("a gh that cannot run points at the setting", async () => {
  const { forge } = forgeReplaying([{ exitCode: null, spawnError: "spawn /opt/gh/bin/gh ENOENT" }]);

  await assert.rejects(
    forge.fetchChangeRequest(PR_105),
    new CliNotFoundError(
      'Could not run gh at "/opt/gh/bin/gh" (spawn /opt/gh/bin/gh ENOENT). Set the gh path in the Guided Review settings.',
    ),
  );
});

test("reads only where a pull request's head is now, its state and its description, for noticing a push or an edit", async () => {
  // The recorded pull request's own head, state and description, as the smaller query returns them.
  const { headRefOid, state, body } = JSON.parse(fixture("pull-request.json")).data.repository.pullRequest;
  const { forge, run } = forgeReplaying([{ stdout: JSON.stringify({ data: { repository: { pullRequest: { headRefOid, state, body } } } }) }]);

  assert.deepEqual(await forge.fetchHead(PR_105), { headSha: "a711a639b04f3bd2bfe514157e0c19880fe33028", state: "merged", description: body });
  assert.deepEqual(
    run.calls.map((call) => ({ args: call.args, input: call.input && JSON.parse(call.input) })),
    [
      {
        args: ["api", "graphql", "--hostname", "github.com", "--input", "-"],
        input: { query: PULL_REQUEST_HEAD_QUERY, variables: { owner: "sleeyax", name: "paseo-plugins", number: 105 } },
      },
    ],
  );
});

test("lists the pull requests each commit belongs to in one query", async () => {
  const { forge, run } = forgeReplaying([{ stdout: fixture("commit-pull-requests.json") }]);
  const first = "93757ac9e0893b2d338a0c727f2e183c5defb6db";

  const listed = await forge.commitChangeRequests(PR_105, [first, "f".repeat(40)]);

  assert.deepEqual(Object.fromEntries(listed), {
    [first]: [
      {
        number: 105,
        url: "https://github.com/sleeyax/paseo-plugins/pull/105",
        title: "chore: build the plugins against Paseo SDK 0.9.2",
        state: "merged",
        sourceBranch: "chore/paseo-sdk-0.9.2",
        targetBranch: "main",
      },
    ],
    ["f".repeat(40)]: [],
  });
  assert.deepEqual(JSON.parse(run.calls[0]?.input ?? ""), {
    query: COMMIT_PULL_REQUESTS_QUERY,
    variables: { owner: "sleeyax", name: "paseo-plugins", number: 105 },
  });
});

test("counts the commits since an earlier head from the pull request's latest, newest last", async () => {
  const answer = (oids: string[], totalCount: number) => ({
    stdout: JSON.stringify({ data: { repository: { pullRequest: { commits: { totalCount, nodes: oids.map((oid) => ({ commit: { oid } })) } } } } }),
  });
  const { forge, run } = forgeReplaying([answer(["a", "b", "c", "d"], 4), answer(["c", "d"], 2), answer(["c", "d"], 180)]);

  assert.deepEqual(await forge.commitsSince(PR_105, "b"), { kind: "after", count: 2 });
  assert.deepEqual(await forge.commitsSince(PR_105, "b"), { kind: "rewritten" });
  assert.equal(await forge.commitsSince(PR_105, "b"), null);
  assert.deepEqual(JSON.parse(run.calls[0]?.input ?? ""), {
    query: PULL_REQUEST_COMMITS_QUERY,
    variables: { owner: "sleeyax", name: "paseo-plugins", number: 105 },
  });
});

test("the head of a pull request GitHub does not have fails with a sentence", async () => {
  const { forge } = forgeReplaying([{ stdout: fixture("pull-request-missing.json") }]);

  await assert.rejects(forge.fetchHead(PR_105), new ForgeError("sleeyax/paseo-plugins has no pull request #105."));
});

test("identifies the current user on the pull request's host", async () => {
  const { forge, run } = forgeReplaying([{ stdout: fixture("user.json") }]);

  assert.deepEqual(await forge.currentUser(PR_105), { login: "sleeyax", name: "Sleeyax" });
  assert.deepEqual(run.calls.map((call) => call.args), [["api", "--hostname", "github.com", "user"]]);
});

test("clones the pull request's repository with gh", async () => {
  const { forge, run } = forgeReplaying([{}]);

  await forge.cloneRepository(PR_105, "/data/clones/github.com/sleeyax/paseo-plugins");

  assert.deepEqual(run.calls.map((call) => call.args), [
    ["repo", "clone", "github.com/sleeyax/paseo-plugins", "/data/clones/github.com/sleeyax/paseo-plugins"],
  ]);
});

test("finds the open pull request whose source branch is a workspace's branch", async () => {
  // Recorded for sleeyax/paseo-plugins' feat/guided-review, which has #107 open.
  const { forge, run } = forgeReplaying([{ stdout: fixture("pull-requests-for-branch.json") }]);

  assert.deepEqual(await forge.findByBranch({ host: "github.com", project: "sleeyax/paseo-plugins" }, "feat/guided-review"), [
    {
      ref: {
        forge: "github",
        host: "github.com",
        project: "sleeyax/paseo-plugins",
        number: 107,
        url: "https://github.com/sleeyax/paseo-plugins/pull/107",
      },
      title: "feat(guided-review): a trunk-first guide to a PR/MR, with a draft review built alongside it",
      author: "sleeyax",
      headSha: "5b416c8bfea2017be77fe2081fcbe223e1b82ecb",
    },
  ]);
  assert.deepEqual(run.calls.map((call) => call.args), [
    [
      "pr",
      "list",
      "--repo",
      "github.com/sleeyax/paseo-plugins",
      "--head",
      "feat/guided-review",
      "--state",
      "open",
      "--json",
      "number,url,title,author,headRefOid",
      "--limit",
      "20",
    ],
  ]);
});

test("a branch with no open pull request finds none, and a repository elsewhere is not GitHub's", async () => {
  const { forge, run } = forgeReplaying([{ stdout: fixture("pull-requests-for-branch-none.json") }]);

  assert.deepEqual(await forge.findByBranch({ host: "github.com", project: "sleeyax/paseo-plugins" }, "no-such-branch"), []);
  assert.equal(await forge.findByBranch({ host: "gitlab.com", project: "sleeyax/paseo-plugins" }, "main"), null);
  assert.equal(run.calls.length, 1, "gh is not asked about another host");
});

/*
 * Drafts. The GraphQL answers under `fixtures/github/` named `pending-review*`, `start-review` and
 * `drafts-*` are built by hand from GitHub's schema for #105, since recording them would write to a
 * real pull request; the mutation answers below are too.
 */

const PR_105_TARGET: DraftTarget = {
  ref: PR_105,
  baseSha: "41ff25de85931953ace4daa1a7923e20823514c5",
  startSha: "41ff25de85931953ace4daa1a7923e20823514c5",
  headSha: "a711a639b04f3bd2bfe514157e0c19880fe33028",
};

const PENDING_REVIEW_ID = "PRR_kwDOUFGNmM7x0Pnd";

/** Every call as it went out, as GraphQL: the query and variables sent on stdin. */
function graphqlCalls(run: FakeCommandRunner) {
  return run.calls.map((call) => {
    assert.deepEqual(call.args, ["api", "graphql", "--hostname", "github.com", "--input", "-"]);
    return JSON.parse(call.input ?? "null") as { query: string; variables: Record<string, unknown> };
  });
}

/** `addPullRequestReviewThread`'s answer for a new thread with one comment. */
function addedThread(thread: { path: string; line?: number; startLine?: number; diffSide?: string; startDiffSide?: string; subjectType?: string }) {
  const line = thread.line ?? null;
  const startLine = thread.startLine ?? null;
  return JSON.stringify({
    data: {
      addPullRequestReviewThread: {
        thread: {
          path: thread.path,
          line,
          originalLine: line,
          startLine,
          originalStartLine: startLine,
          diffSide: thread.diffSide ?? "RIGHT",
          startDiffSide: thread.startDiffSide ?? null,
          subjectType: thread.subjectType ?? "LINE",
          comments: { nodes: [{ id: "PRRC_kwDOUFGNmM6kZ9z9", body: "Why 0.9.2?" }] },
        },
      },
    },
  });
}

const ADDED: AnchorLine = { kind: "added", oldLine: null, newLine: 11, oldPos: 12, newPos: 11 };
const REMOVED: AnchorLine = { kind: "removed", oldLine: 11, newLine: null, oldPos: 11, newPos: 11 };
const CONTEXT: AnchorLine = { kind: "context", oldLine: 10, newLine: 10, oldPos: 10, newPos: 10 };
const PACKAGE_JSON = { path: "plugins/catppuccin-theme/package.json", previousPath: null };

test("lists the viewer's pending comments across every page of threads, and nobody else's", async () => {
  const { forge, run } = forgeReplaying([{ stdout: fixture("drafts-page-1.json") }, { stdout: fixture("drafts-page-2.json") }]);

  const drafts = await forge.listDrafts(PR_105);

  assert.deepEqual(graphqlCalls(run), [
    { query: DRAFTS_QUERY, variables: { owner: "sleeyax", name: "paseo-plugins", number: 105, after: null } },
    { query: DRAFTS_QUERY, variables: { owner: "sleeyax", name: "paseo-plugins", number: 105, after: "Y3Vyc29yOnYyOpHOAAAABg==" } },
  ]);
  assert.deepEqual(drafts, [
    {
      id: "PRRC_kwDOUFGNmM6kZ1a1",
      body: "Pin this to the host's version.",
      location: { kind: "line", path: "plugins/catppuccin-theme/package.json", line: { side: "new", line: 11 } },
    },
    {
      id: "PRRC_kwDOUFGNmM6kZ1a2",
      body: "Was 0.9.1 ever released?",
      location: { kind: "line", path: "plugins/claude-tty/package.json", line: { side: "old", line: 11 } },
    },
    {
      id: "PRRC_kwDOUFGNmM6kZ1a3",
      body: "Both bumps belong together.",
      location: {
        kind: "range",
        path: "plugins/claude-tty/package.json",
        start: { side: "old", line: 11 },
        end: { side: "new", line: 12 },
      },
    },
    { id: "PRRC_kwDOUFGNmM6kZ1a4", body: "Regenerated with pnpm 11?", location: { kind: "file", path: "pnpm-lock.yaml" } },
    // A pending reply to someone else's published thread sits where that thread does.
    {
      id: "PRRC_kwDOUFGNmM6kZ1a5",
      body: "Agreed, 0.9.2.",
      location: { kind: "line", path: "plugins/claude-tty/CLAUDE.md", line: { side: "new", line: 334 } },
    },
    // An outdated thread has no current line, so it keeps its original one.
    {
      id: "PRRC_kwDOUFGNmM6kZ1a6",
      body: "Name the key rather than the sequence.",
      location: { kind: "line", path: "apps/claude-tty-acp/src/claude-runtime.test.ts", line: { side: "new", line: 24 } },
    },
    {
      id: "PRRC_kwDOUFGNmM6kZ1a7",
      body: "A constant per key reads well.",
      location: {
        kind: "range",
        path: "apps/claude-tty-acp/src/claude-runtime.test.ts",
        start: { side: "new", line: 23 },
        end: { side: "new", line: 24 },
      },
    },
  ]);
});

test("a viewer with no pending review has no drafts, and no more pages are read", async () => {
  const { forge, run } = forgeReplaying([{ stdout: fixture("drafts-none.json") }]);

  assert.deepEqual(await forge.listDrafts(PR_105), []);
  assert.equal(run.calls.length, 1);
});

test("a draft goes on the pending review the viewer already has, even one started on github.com", async () => {
  const { forge, run } = forgeReplaying([
    { stdout: fixture("pending-review.json") },
    { stdout: addedThread({ path: PACKAGE_JSON.path, line: 11 }) },
  ]);

  const draft = await forge.createDraft(PR_105_TARGET, { anchor: { kind: "line", ...PACKAGE_JSON, line: ADDED }, body: "Why 0.9.2?" });

  assert.deepEqual(graphqlCalls(run), [
    { query: PENDING_REVIEW_QUERY, variables: { owner: "sleeyax", name: "paseo-plugins", number: 105 } },
    {
      query: ADD_THREAD_MUTATION,
      variables: {
        input: {
          pullRequestReviewId: PENDING_REVIEW_ID,
          path: "plugins/catppuccin-theme/package.json",
          body: "Why 0.9.2?",
          subjectType: "LINE",
          line: 11,
          side: "RIGHT",
        },
      },
    },
  ]);
  assert.deepEqual(draft, {
    id: "PRRC_kwDOUFGNmM6kZ9z9",
    body: "Why 0.9.2?",
    location: { kind: "line", path: "plugins/catppuccin-theme/package.json", line: { side: "new", line: 11 } },
  });
});

test("without a pending review, one is started on the guide's head, pending, and the draft goes on it", async () => {
  const { forge, run } = forgeReplaying([
    { stdout: fixture("pending-review-none.json") },
    { stdout: fixture("start-review.json") },
    { stdout: addedThread({ path: PACKAGE_JSON.path, line: 11 }) },
  ]);

  await forge.createDraft(PR_105_TARGET, { anchor: { kind: "line", ...PACKAGE_JSON, line: ADDED }, body: "Why 0.9.2?" });

  const calls = graphqlCalls(run);
  assert.deepEqual(calls.slice(0, 2), [
    { query: PENDING_REVIEW_QUERY, variables: { owner: "sleeyax", name: "paseo-plugins", number: 105 } },
    {
      query: START_REVIEW_MUTATION,
      variables: { pullRequestId: "PR_kwDOUFGNmM8AAAABFhb6LA", commitOID: "a711a639b04f3bd2bfe514157e0c19880fe33028" },
    },
  ]);
  // No event: the review stays pending, and nothing is published until it is submitted.
  assert.doesNotMatch(START_REVIEW_MUTATION, /event/);
  assert.equal(calls[2]?.query, ADD_THREAD_MUTATION);
  assert.equal((calls[2]?.variables.input as { pullRequestReviewId: string }).pullRequestReviewId, "PRR_kwDOUFGNmM7x0Qaa");
});

test("drafts saved at once start one pending review between them", async () => {
  const { forge, run } = forgeReplaying([
    { stdout: fixture("pending-review-none.json") },
    { stdout: fixture("start-review.json") },
    { stdout: addedThread({ path: PACKAGE_JSON.path, line: 11 }) },
    { stdout: fixture("pending-review.json") },
    { stdout: addedThread({ path: PACKAGE_JSON.path, line: 11, diffSide: "LEFT" }) },
  ]);

  await Promise.all([
    forge.createDraft(PR_105_TARGET, { anchor: { kind: "line", ...PACKAGE_JSON, line: ADDED }, body: "One" }),
    forge.createDraft(PR_105_TARGET, { anchor: { kind: "line", ...PACKAGE_JSON, line: REMOVED }, body: "Two" }),
  ]);

  assert.deepEqual(
    graphqlCalls(run).map((call) => call.query),
    [PENDING_REVIEW_QUERY, START_REVIEW_MUTATION, ADD_THREAD_MUTATION, PENDING_REVIEW_QUERY, ADD_THREAD_MUTATION],
  );
});

test("each anchor becomes the thread fields GitHub anchors it by", async () => {
  const cases: { name: string; anchor: Exclude<DraftAnchor, { kind: "general" }>; fields: Record<string, unknown>; answer: Parameters<typeof addedThread>[0] }[] = [
    {
      name: "an added line is on the RIGHT by its new number",
      anchor: { kind: "line", ...PACKAGE_JSON, line: ADDED },
      fields: { subjectType: "LINE", line: 11, side: "RIGHT" },
      answer: { path: PACKAGE_JSON.path, line: 11, diffSide: "RIGHT" },
    },
    {
      name: "a removed line is on the LEFT by its old number",
      anchor: { kind: "line", ...PACKAGE_JSON, line: REMOVED },
      fields: { subjectType: "LINE", line: 11, side: "LEFT" },
      answer: { path: PACKAGE_JSON.path, line: 11, diffSide: "LEFT" },
    },
    {
      name: "an unchanged line is on the RIGHT by its new number",
      anchor: { kind: "line", ...PACKAGE_JSON, line: { ...CONTEXT, oldLine: 9, oldPos: 9 } },
      fields: { subjectType: "LINE", line: 10, side: "RIGHT" },
      answer: { path: PACKAGE_JSON.path, line: 10, diffSide: "RIGHT" },
    },
    {
      name: "a range sets its first line's number and side, then its last's",
      anchor: { kind: "range", ...PACKAGE_JSON, start: CONTEXT, end: ADDED },
      fields: { subjectType: "LINE", startLine: 10, startSide: "RIGHT", line: 11, side: "RIGHT" },
      answer: { path: PACKAGE_JSON.path, startLine: 10, startDiffSide: "RIGHT", line: 11, diffSide: "RIGHT" },
    },
    {
      name: "a range from a removed line to an added one crosses sides",
      anchor: { kind: "range", ...PACKAGE_JSON, start: REMOVED, end: ADDED },
      fields: { subjectType: "LINE", startLine: 11, startSide: "LEFT", line: 11, side: "RIGHT" },
      answer: { path: PACKAGE_JSON.path, startLine: 11, startDiffSide: "LEFT", line: 11, diffSide: "RIGHT" },
    },
    {
      name: "a file is subject type FILE, with no line",
      anchor: { kind: "file", path: "pnpm-lock.yaml", previousPath: null },
      fields: { subjectType: "FILE" },
      answer: { path: "pnpm-lock.yaml", subjectType: "FILE" },
    },
  ];

  for (const { name, anchor, fields, answer } of cases) {
    const { forge, run } = forgeReplaying([{ stdout: fixture("pending-review.json") }, { stdout: addedThread(answer) }]);

    const draft = await forge.createDraft(PR_105_TARGET, { anchor, body: "Why 0.9.2?" });

    assert.deepEqual(
      graphqlCalls(run)[1]?.variables,
      { input: { pullRequestReviewId: PENDING_REVIEW_ID, path: anchor.path, body: "Why 0.9.2?", ...fields } },
      name,
    );
    assert.equal(draft.location.kind, anchor.kind, name);
  }
});

test("a line GitHub cannot place fails in GitHub's words", async () => {
  const { forge } = forgeReplaying([
    { stdout: fixture("pending-review.json") },
    {
      exitCode: 1,
      stdout: JSON.stringify({ data: { addPullRequestReviewThread: { thread: null } }, errors: [{ message: "Line could not be resolved" }] }),
      stderr: "gh: Line could not be resolved\n",
    },
  ]);

  await assert.rejects(
    forge.createDraft(PR_105_TARGET, { anchor: { kind: "line", ...PACKAGE_JSON, line: ADDED }, body: "Why?" }),
    new ForgeError("gh failed: Line could not be resolved"),
  );
});

test("a comment on the pull request as a whole is not a draft thread: GitHub keeps it in the review body", async () => {
  const { forge, run } = forgeReplaying([]);

  await assert.rejects(forge.createDraft(PR_105_TARGET, { anchor: { kind: "general" }, body: "About the bump: why now?" }), ForgeError);
  assert.equal(run.calls.length, 0, "gh was not run");
});

test("edits a draft's text and deletes a draft by its comment ID", async () => {
  const { forge, run } = forgeReplaying([
    { stdout: JSON.stringify({ data: { updatePullRequestReviewComment: { pullRequestReviewComment: { id: "PRRC_kwDOUFGNmM6kZ1a1" } } } }) },
    { stdout: JSON.stringify({ data: { deletePullRequestReviewComment: { pullRequestReviewComment: { id: "PRRC_kwDOUFGNmM6kZ1a2" } } } }) },
  ]);

  await forge.updateDraft(PR_105, "PRRC_kwDOUFGNmM6kZ1a1", "42");
  await forge.deleteDraft(PR_105, "PRRC_kwDOUFGNmM6kZ1a2");

  assert.deepEqual(graphqlCalls(run), [
    // The text goes as a JSON string, so a body of "42" stays text.
    { query: UPDATE_COMMENT_MUTATION, variables: { id: "PRRC_kwDOUFGNmM6kZ1a1", body: "42" } },
    { query: DELETE_COMMENT_MUTATION, variables: { id: "PRRC_kwDOUFGNmM6kZ1a2" } },
  ]);
});

/*
 * Finishing a review. The answers are built by hand from GitHub's schema, as the draft ones are:
 * recording them would publish or delete a real review.
 */

function submitted(state: string): string {
  return JSON.stringify({ data: { submitPullRequestReview: { pullRequestReview: { id: PENDING_REVIEW_ID, state } } } });
}

test("submits the pending review, its comments and body with it, as the verdict GitHub calls it by", async () => {
  const cases = [
    { verdict: "approve", event: "APPROVE", state: "APPROVED", label: "Publish the review and approve" },
    { verdict: "request-changes", event: "REQUEST_CHANGES", state: "CHANGES_REQUESTED", label: "Publish the review and request changes" },
    { verdict: "comment", event: "COMMENT", state: "COMMENTED", label: "Publish the review as a comment" },
  ] as const;

  for (const { verdict, event, state, label } of cases) {
    const { forge, run } = forgeReplaying([{ stdout: fixture("pending-review.json") }, { stdout: submitted(state) }]);

    const outcome = await forge.submitReview(PR_105_TARGET, { verdict, body: "Reads well.\n\nOne question on the lockfile.", approveHeadSha: PR_105_TARGET.headSha });

    assert.deepEqual(
      graphqlCalls(run),
      [
        { query: PENDING_REVIEW_QUERY, variables: { owner: "sleeyax", name: "paseo-plugins", number: 105 } },
        { query: SUBMIT_REVIEW_MUTATION, variables: { id: PENDING_REVIEW_ID, event, body: "Reads well.\n\nOne question on the lockfile." } },
      ],
      verdict,
    );
    assert.deepEqual(outcome, { published: true, steps: [{ id: "submit", label, status: "done", message: null }] }, verdict);
  }
});

test("a submit with nothing pending, like an approval without comments, starts the review on the guide's head first", async () => {
  const { forge, run } = forgeReplaying([
    { stdout: fixture("pending-review-none.json") },
    { stdout: fixture("start-review.json") },
    { stdout: submitted("APPROVED") },
  ]);

  await forge.submitReview(PR_105_TARGET, { verdict: "approve", body: "", approveHeadSha: PR_105_TARGET.headSha });

  assert.deepEqual(graphqlCalls(run).slice(1), [
    {
      query: START_REVIEW_MUTATION,
      variables: { pullRequestId: "PR_kwDOUFGNmM8AAAABFhb6LA", commitOID: "a711a639b04f3bd2bfe514157e0c19880fe33028" },
    },
    { query: SUBMIT_REVIEW_MUTATION, variables: { id: "PRR_kwDOUFGNmM7x0Qaa", event: "APPROVE", body: "" } },
  ]);
});

test("a submit GitHub turns down is reported as a failed step in GitHub's words, not thrown", async () => {
  const { forge } = forgeReplaying([
    { stdout: fixture("pending-review.json") },
    { exitCode: 1, stderr: "gh: Can not request changes on your own pull request\n" },
  ]);

  const outcome = await forge.submitReview(PR_105_TARGET, { verdict: "request-changes", body: "Please split this.", approveHeadSha: PR_105_TARGET.headSha });

  assert.deepEqual(outcome, {
    published: false,
    steps: [
      {
        id: "submit",
        label: "Publish the review and request changes",
        status: "failed",
        message: "gh failed: Can not request changes on your own pull request",
      },
    ],
  });
});

test("discarding deletes the viewer's pending review, and with none pending changes nothing", async () => {
  const { forge, run } = forgeReplaying([
    { stdout: fixture("pending-review.json") },
    { stdout: JSON.stringify({ data: { deletePullRequestReview: { pullRequestReview: { id: PENDING_REVIEW_ID } } } }) },
    { stdout: fixture("pending-review-none.json") },
  ]);

  await forge.discardReview(PR_105);
  await forge.discardReview(PR_105);

  assert.deepEqual(graphqlCalls(run), [
    { query: PENDING_REVIEW_QUERY, variables: { owner: "sleeyax", name: "paseo-plugins", number: 105 } },
    { query: DELETE_REVIEW_MUTATION, variables: { id: PENDING_REVIEW_ID } },
    { query: PENDING_REVIEW_QUERY, variables: { owner: "sleeyax", name: "paseo-plugins", number: 105 } },
  ]);
});

test("a comment on the pull request as a whole is posted to its conversation, the text sent as JSON", async () => {
  const { forge, run } = forgeReplaying([{ stdout: JSON.stringify({ id: 1, body: "42" }) }]);

  await forge.postComment(PR_105, "42");

  assert.deepEqual(
    run.calls.map((call) => ({ args: call.args, input: call.input })),
    [
      {
        args: ["api", "--hostname", "github.com", "--method", "POST", "repos/sleeyax/paseo-plugins/issues/105/comments", "--input", "-"],
        input: JSON.stringify({ body: "42" }),
      },
    ],
  );
});

test("lists the files changed between two commits, and none once GitHub's comparison stops listing them", async () => {
  const from = "93757ac9e0893b2d338a0c727f2e183c5defb6db";
  const to = "a711a639b04f3bd2bfe514157e0c19880fe33028";
  const full = JSON.stringify({ files: Array.from({ length: MAX_COMPARE_FILES }, (_, index) => ({ filename: `f${index}` })) });
  const { forge, run } = forgeReplaying([{ stdout: fixture("compare.json") }, { stdout: full }]);

  assert.deepEqual(await forge.changedPaths(PR_105, from, to), ["apps/claude-tty-acp/src/claude-runtime.test.ts", "plugins/claude-tty/CLAUDE.md"]);
  assert.equal(await forge.changedPaths(PR_105, from, to), null);
  assert.deepEqual(run.calls[0]?.args, ["api", "--hostname", "github.com", `repos/sleeyax/paseo-plugins/compare/${from}...${to}`]);
});

test("a discussion on the pull request is a comment on its conversation, as GitHub has no thread on a PR as a whole", async () => {
  const { forge, run } = forgeReplaying([{ stdout: JSON.stringify({ id: 1, body: "42" }) }]);

  await forge.startDiscussion(PR_105, "42");

  assert.deepEqual(run.calls[0]?.args, ["api", "--hostname", "github.com", "--method", "POST", "repos/sleeyax/paseo-plugins/issues/105/comments", "--input", "-"]);
});

/** A listing's three searches as gh answers them, in the order they go out: asked to review, reviewed, authored. */
function searches(answers: { requested?: ScriptedResult; reviewed?: ScriptedResult; authored?: ScriptedResult } = {}): ScriptedResult[] {
  return [
    answers.requested ?? { stdout: fixture("review-search-requested.json") },
    answers.reviewed ?? { stdout: fixture("review-search-reviewed.json") },
    answers.authored ?? { stdout: fixture("review-search-authored.json") },
  ];
}

test("lists what the viewer is asked to review, what they reviewed and what they authored, as three searches on github.com", async () => {
  const { forge, run } = forgeReplaying(searches());

  const [host, ...others] = await forge.listChangeRequests();

  assert.deepEqual(others, []);
  assert.deepEqual(
    run.calls.map((call) => call.args),
    [
      ["api", "graphql", "--hostname", "github.com", "--input", "-"],
      ["api", "graphql", "--hostname", "github.com", "--input", "-"],
      ["api", "graphql", "--hostname", "github.com", "--input", "-"],
    ],
  );
  assert.deepEqual(graphqlCalls(run), [
    { query: REVIEW_SEARCH_QUERY, variables: { query: REVIEW_SEARCHES.requested } },
    { query: REVIEW_SEARCH_QUERY, variables: { query: REVIEW_SEARCHES.reviewed } },
    { query: AUTHORED_SEARCH_QUERY, variables: { query: REVIEW_SEARCHES.authored } },
  ]);
  assert.equal(host?.forge, "github");
  assert.equal(host?.host, "github.com");
  assert.equal(host?.error, null);
  assert.deepEqual(host?.truncated, { assigned: false, authored: false });
  assert.equal(host?.assigned.length, 7);

  assert.deepEqual(host?.assigned[0], {
    forge: "github",
    host: "github.com",
    project: "sleeyax/paseo-plugins",
    number: 105,
    url: "https://github.com/sleeyax/paseo-plugins/pull/105",
    title: "feat(guided-review): suggest wording for a comment",
    author: "sleeyax-bot",
    isDraft: false,
    createdAt: "2026-09-20T09:12:44Z",
    updatedAt: "2026-10-04T18:03:10Z",
    headSha: "6f1d2c0a9b8e7d6c5b4a39281706f5e4d3c2b1a0",
    additions: 412,
    deletions: 37,
    fileCount: 14,
    ci: "failure",
    state: "requested",
    viaTeam: null,
    changedSinceReview: null,
    pendingDrafts: 2,
  });
});

test("a PR the viewer is asked to review again reads as requested and changed, with the team it was asked of", async () => {
  const { forge } = forgeReplaying(searches());

  const [host] = await forge.listChangeRequests();
  const again = host?.assigned.find((request) => request.number === 7);

  assert.equal(again?.author, "ghost");
  assert.equal(again?.isDraft, true);
  assert.equal(again?.ci, null);
  assert.equal(again?.state, "requested");
  assert.equal(again?.viaTeam, "example-org/backend");
  assert.equal(again?.changedSinceReview, true);
  assert.equal(again?.pendingDrafts, 0);
});

test("a PR the viewer reviewed and is not asked again reads by their review, changed when the head moved past it", async () => {
  const { forge } = forgeReplaying(searches());

  const [host] = await forge.listChangeRequests();
  const byUrl = (url: string) => host?.assigned.find((request) => request.url === url);

  const commented = byUrl("https://github.com/themouette/claude-vm/pull/96");
  assert.equal(commented?.state, "commented");
  assert.equal(commented?.ci, "success");
  assert.equal(commented?.viaTeam, null);
  assert.equal(commented?.changedSinceReview, false);
  assert.equal(byUrl("https://github.com/stretchr/testify/pull/1546")?.state, "approved");
});

test("a PR the viewer reviewed without being asked, by name or through a team, is left out", async () => {
  const { forge } = forgeReplaying(searches());

  const [host] = await forge.listChangeRequests();
  const urls = host?.assigned.map((request) => request.url);

  assert.ok(!urls?.includes("https://github.com/magisterquis/connectproxy/pull/2"));
  assert.ok(!urls?.includes("https://github.com/sickcodes/Docker-OSX/pull/819"));
  assert.ok(urls?.includes("https://github.com/stretchr/testify/pull/1546"));
  assert.ok(urls?.includes("https://github.com/stretchr/testify/pull/1467"));
});

test("a search with more results than it returned marks its list on the host as truncated", async () => {
  const more = (name: string) => {
    const answer = JSON.parse(fixture(name));
    answer.data.search.issueCount = 120;
    return { stdout: JSON.stringify(answer) };
  };

  const [assigned] = await forgeReplaying(searches({ requested: more("review-search-requested.json") })).forge.listChangeRequests();
  const [authored] = await forgeReplaying(searches({ authored: more("review-search-authored.json") })).forge.listChangeRequests();

  assert.deepEqual(assigned?.truncated, { assigned: true, authored: false });
  assert.deepEqual(authored?.truncated, { assigned: false, authored: true });
});

test("a search gh cannot run comes back as the host's error once, with both lists empty, rather than a throw", async () => {
  const failed = { exitCode: 4, stderr: "To get started with GitHub CLI, please run:  gh auth login\n" };
  const error = {
    forge: "github",
    host: "github.com",
    assigned: [],
    authored: [],
    truncated: { assigned: false, authored: false },
    error: "gh failed: To get started with GitHub CLI, please run:  gh auth login",
  };

  assert.deepEqual(await forgeReplaying(searches({ requested: failed })).forge.listChangeRequests(), [error]);
  assert.deepEqual(await forgeReplaying(searches({ authored: failed })).forge.listChangeRequests(), [error]);
});

test("the viewer's own open PRs list as authored, drafts included, with their own pending drafts and where their reviewers stand", async () => {
  const [host] = await forgeReplaying(searches()).forge.listChangeRequests();

  assert.deepEqual(host?.authored, [
    {
      forge: "github",
      host: "github.com",
      project: "example-org/uploader",
      number: 31,
      url: "https://github.com/example-org/uploader/pull/31",
      title: "Resume uploads after a dropped connection",
      author: "sleeyax",
      isDraft: false,
      createdAt: "2026-10-01T08:30:00Z",
      updatedAt: "2026-10-06T16:45:12Z",
      headSha: "3c9e0b7a1f2d4e6c8b0a9f8e7d6c5b4a39281706",
      additions: 128,
      deletions: 14,
      fileCount: 5,
      ci: "failure",
      pendingDrafts: 1,
      status: "changes-requested",
      reviewers: [
        { name: "alice", state: "approved" },
        { name: "bob", state: "changes-requested" },
        { name: "example-org/backend", state: "requested" },
      ],
      reviewedSinceLastPush: true,
      latestReviewAt: "2026-10-06T15:02:40Z",
    },
    {
      forge: "github",
      host: "github.com",
      project: "example-org/docs",
      number: 4,
      url: "https://github.com/example-org/docs/pull/4",
      title: "Describe the retry settings",
      author: "sleeyax",
      isDraft: true,
      createdAt: "2026-10-05T11:00:00Z",
      updatedAt: "2026-10-05T11:20:00Z",
      headSha: "9a8b7c6d5e4f3a2b1c0d9e8f7a6b5c4d3e2f1a0b",
      additions: 6,
      deletions: 0,
      fileCount: 1,
      ci: null,
      pendingDrafts: 0,
      status: "unreviewed",
      reviewers: [],
      reviewedSinceLastPush: false,
      latestReviewAt: null,
    },
  ]);
});

const HEAD_31 = "3c9e0b7a1f2d4e6c8b0a9f8e7d6c5b4a39281706";
const EARLIER_31 = "0b1c2d3e4f5a6b7c8d9e0f1a2b3c4d5e6f7a8b9c";

type LatestReview = { state: string; submittedAt: string; author: { login: string }; commit: { oid: string } };

function review(login: string, state: string, commit = HEAD_31, submittedAt = "2026-10-06T15:00:00Z"): LatestReview {
  return { state, submittedAt, author: { login }, commit: { oid: commit } };
}

/** GitHub dismissing `login`'s approval submitted at `submittedAt`, on a push or by hand. */
function dismissal(login: string, pushed: boolean, submittedAt = "2026-10-04T10:00:00Z") {
  return { previousReviewState: "APPROVED", pullRequestCommit: pushed ? { id: "PURC_1" } : null, review: { author: { login }, submittedAt } };
}

/**
 * The authored PR #31 as the search answers it, with these reviewers asked, reviews and dismissals in place of the fixture's.
 * `reviews` is each reviewer's latest review, and `opinions` their latest approval or change request, which by default are the verdicts among `reviews`.
 */
async function authored31(pr: { asked?: string[]; reviews?: LatestReview[]; opinions?: LatestReview[]; dismissals?: object[] }) {
  const answer = JSON.parse(fixture("review-search-authored.json"));
  const node = answer.data.search.nodes[0];
  const reviews = pr.reviews ?? [];
  node.reviewRequests.nodes = (pr.asked ?? []).map((login) => ({ requestedReviewer: { __typename: "User", login } }));
  node.latestReviews.nodes = reviews;
  node.latestOpinionatedReviews.nodes = pr.opinions ?? reviews.filter((latest) => latest.state === "APPROVED" || latest.state === "CHANGES_REQUESTED");
  node.timelineItems.nodes = pr.dismissals ?? [];
  const [host] = await forgeReplaying(searches({ authored: { stdout: JSON.stringify(answer) } })).forge.listChangeRequests();
  return host!.authored[0]!;
}

test("an approval GitHub dismissed on a push reads as an approval reset, and one dismissed by hand does not", async () => {
  const dismissed = [review("alice", "DISMISSED", EARLIER_31, "2026-10-04T10:00:00Z")];

  const reset = await authored31({ reviews: dismissed, dismissals: [dismissal("alice", true)] });
  const byHand = await authored31({ reviews: dismissed, dismissals: [dismissal("alice", false)] });

  assert.equal(reset.status, "approval-reset");
  assert.deepEqual(reset.reviewers, [{ name: "alice", state: "unapproved" }]);
  assert.equal(byHand.status, "commented");
  assert.deepEqual(byHand.reviewers, [{ name: "alice", state: "commented" }]);
});

test("a comment after an approval leaves the approval standing", async () => {
  const approved = await authored31({
    reviews: [review("alice", "COMMENTED", HEAD_31, "2026-10-06T15:00:00Z")],
    opinions: [review("alice", "APPROVED", EARLIER_31, "2026-10-04T10:00:00Z")],
  });

  assert.equal(approved.status, "approved");
  assert.deepEqual(approved.reviewers, [{ name: "alice", state: "approved" }]);
  assert.equal(approved.reviewedSinceLastPush, true);
  assert.equal(approved.latestReviewAt, "2026-10-06T15:00:00Z");
});

test("a comment after a change request leaves the change request standing", async () => {
  const blocked = await authored31({
    reviews: [review("bob", "COMMENTED", HEAD_31, "2026-10-06T15:00:00Z")],
    opinions: [review("bob", "CHANGES_REQUESTED", EARLIER_31, "2026-10-04T10:00:00Z")],
  });

  assert.equal(blocked.status, "changes-requested");
  assert.deepEqual(blocked.reviewers, [{ name: "bob", state: "changes-requested" }]);
});

test("an approval GitHub dismissed on a push stays reset through a later comment, until the reviewer approves again", async () => {
  const commentedSince = await authored31({ reviews: [review("alice", "COMMENTED")], dismissals: [dismissal("alice", true)] });
  const approvedAgain = await authored31({ reviews: [review("alice", "APPROVED")], dismissals: [dismissal("alice", true)] });

  assert.equal(commentedSince.status, "approval-reset");
  assert.deepEqual(commentedSince.reviewers, [{ name: "alice", state: "unapproved" }]);
  assert.deepEqual(approvedAgain.reviewers, [{ name: "alice", state: "approved" }]);
});

test("an approval still standing beats one GitHub took back, and a change request beats both", async () => {
  const approved = [review("alice", "APPROVED"), review("bob", "DISMISSED", EARLIER_31, "2026-10-04T10:00:00Z")];
  const reset = [dismissal("bob", true)];

  assert.equal((await authored31({ reviews: approved, dismissals: reset })).status, "approved");
  assert.equal((await authored31({ reviews: [...approved, review("carol", "CHANGES_REQUESTED", EARLIER_31)], dismissals: reset })).status, "changes-requested");
});

test("reviewers asked and none answered is waiting, and a review without a verdict is commented", async () => {
  const waiting = await authored31({ asked: ["alice", "bob"] });
  const commented = await authored31({ asked: ["bob"], reviews: [review("alice", "COMMENTED", EARLIER_31, "2026-10-04T10:00:00Z")] });

  assert.equal(waiting.status, "waiting");
  assert.deepEqual(waiting.reviewers, [
    { name: "alice", state: "requested" },
    { name: "bob", state: "requested" },
  ]);
  assert.equal(waiting.reviewedSinceLastPush, false);
  assert.equal(waiting.latestReviewAt, null);
  assert.equal(commented.status, "commented");
  assert.equal(commented.reviewedSinceLastPush, false, "the review is of an earlier commit");
  assert.equal(commented.latestReviewAt, "2026-10-04T10:00:00Z");
});

test("a reviewer asked again is waited on, and their review no longer counts as since the push", async () => {
  const again = await authored31({ asked: ["alice"], reviews: [review("alice", "APPROVED")] });

  assert.equal(again.status, "waiting");
  assert.deepEqual(again.reviewers, [{ name: "alice", state: "requested" }]);
  assert.equal(again.reviewedSinceLastPush, false);
  assert.equal(again.latestReviewAt, "2026-10-06T15:00:00Z");
});

test("a reviewer asked again after requesting changes still holds them, and their review counts as since the push", async () => {
  const again = await authored31({ asked: ["bob"], reviews: [review("bob", "CHANGES_REQUESTED")] });

  assert.equal(again.status, "changes-requested");
  assert.deepEqual(again.reviewers, [{ name: "bob", state: "changes-requested" }]);
  assert.equal(again.reviewedSinceLastPush, true);
});

test("only GitHub's own attachment URLs are attachments", () => {
  const attachments = [
    "https://github.com/user-attachments/assets/0d4e6a3c-1b2f-4c5d-9e8f-123456789abc",
    "https://github.com/sleeyax/paseo-plugins/assets/1234567/0d4e6a3c-1b2f-4c5d-9e8f-123456789abc",
    "https://user-images.githubusercontent.com/1234567/123456789-abcdef.png",
  ];
  const others = [
    "https://example.com/user-attachments/assets/0d4e6a3c",
    "https://img.shields.io/badge/ci-passing-green.svg",
    "http://github.com/user-attachments/assets/0d4e6a3c",
    "https://github.com/sleeyax/paseo-plugins/blob/main/screenshot.png",
    "not a url",
  ];
  assert.deepEqual(attachments.map((url) => isAttachmentUrl(PR_105, url)), [true, true, true]);
  assert.deepEqual(others.map((url) => isAttachmentUrl(PR_105, url)), [false, false, false, false, false]);
});

test("fetches an attachment with gh's login, as bytes under the cap, and leaves any other URL alone", async () => {
  const url = "https://github.com/user-attachments/assets/0d4e6a3c-1b2f-4c5d-9e8f-123456789abc";
  const { forge, run } = forgeReplaying([{ stdout: "iVBORw0KGgo=" }]);

  assert.equal(await forge.fetchAttachment(PR_105, url, 1024), "iVBORw0KGgo=");
  assert.equal(await forge.fetchAttachment(PR_105, "https://img.shields.io/badge/ci.svg", 1024), null);
  assert.deepEqual(
    run.calls.map((call) => ({ args: call.args, stdoutEncoding: call.stdoutEncoding, maxStdoutBytes: call.maxStdoutBytes })),
    [{ args: ["api", url], stdoutEncoding: "base64", maxStdoutBytes: 1024 }],
  );
});

test("an attachment over the cap fails with a sentence", async () => {
  const { forge } = forgeReplaying([{ exitCode: null, spawnError: "Output exceeded 5242880 bytes", outputExceeded: true }]);

  await assert.rejects(
    forge.fetchAttachment(PR_105, "https://github.com/user-attachments/assets/0d4e6a3c", 5 * 1024 * 1024),
    new ForgeError("The file is larger than 5 MB."),
  );
});
