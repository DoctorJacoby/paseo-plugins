import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import type { LineRef } from "../../shared/drafts.ts";
import { anchorAt } from "../anchors.ts";
import { fakeCommandRunner, type ScriptedResult } from "../fake-command-runner.ts";
import { createGitLabForge, parseAuthStatus, parseMergeRequestUrl, REQUEST_CHANGES_MUTATION, REVIEW_LIST_QUERY, uploadOf } from "./gitlab.ts";
import { ForgeError, type AnchorLine, type ChangeRequestRef, type DraftAnchor, type DraftTarget } from "./port.ts";

/**
 * Recorded from `glab` 1.119 against gitlab.com's gitlab-org/cli!3931, a merged MR from a fork, and
 * gitlab-org/cli's project (ID 34675721). The user is whichever account glab was logged in as,
 * trimmed to its public fields.
 */
function fixture(name: string): string {
  return readFileSync(path.join(import.meta.dirname, "fixtures", "gitlab", name), "utf8");
}

const GLAB = "/usr/bin/glab";

function forgeReplaying(script: readonly ScriptedResult[]) {
  const run = fakeCommandRunner(script);
  return { run, forge: createGitLabForge({ run, glab: async () => GLAB }) };
}

const MR_3931: ChangeRequestRef = {
  forge: "gitlab",
  host: "gitlab.com",
  project: "gitlab-org/cli",
  number: 3931,
  url: "https://gitlab.com/gitlab-org/cli/-/merge_requests/3931",
};

const LOGGED_IN: ScriptedResult = { stderr: "gitlab.com\n  ✓ Logged in to gitlab.com as reviewer\n" };
const NOT_LOGGED_IN: ScriptedResult = { exitCode: 1, stderr: fixture("auth-status-unknown-host.stderr") };

/** The whole read of !3931, in the order the adapter asks for it. */
const READ_MR: readonly ScriptedResult[] = [
  LOGGED_IN,
  { stdout: fixture("project.json") },
  { stdout: fixture("merge-request.json") },
  { stdout: fixture("diffs.ndjson") },
  { stdout: fixture("commits.json") },
  { stdout: fixture("closes-issues.json") },
];

test("takes a merge request URL however it was copied", async () => {
  for (const url of [
    "https://gitlab.com/gitlab-org/cli/-/merge_requests/3931",
    "  https://gitlab.com/gitlab-org/cli/-/merge_requests/3931/diffs  ",
    "https://gitlab.com/gitlab-org/cli/-/merge_requests/3931#note_123",
    "https://GitLab.com/gitlab-org/cli/-/merge_requests/3931?tab=commits",
    "gitlab.com/gitlab-org/cli/-/merge_requests/3931",
  ]) {
    assert.deepEqual(parseMergeRequestUrl(url), MR_3931, url);
  }
});

test("reads a subgroup path and a self-hosted host, keeping its port only in the URL", () => {
  assert.deepEqual(parseMergeRequestUrl("https://git.example.com:8443/acme/platform/uploader/-/merge_requests/7/commits"), {
    forge: "gitlab",
    host: "git.example.com",
    project: "acme/platform/uploader",
    number: 7,
    url: "https://git.example.com:8443/acme/platform/uploader/-/merge_requests/7",
  });
  assert.equal(parseMergeRequestUrl("http://gitlab.internal/team/app/-/merge_requests/12")?.url, "http://gitlab.internal/team/app/-/merge_requests/12");
});

test("turns down anything that is not a merge request URL, without running glab", async () => {
  const { forge, run } = forgeReplaying([]);
  for (const url of [
    "",
    "not a url",
    "https://gitlab.com/gitlab-org/cli",
    "https://gitlab.com/gitlab-org/cli/-/issues/8557",
    "https://gitlab.com/gitlab-org/cli/-/merge_requests",
    "https://gitlab.com/gitlab-org/cli/-/merge_requests/0",
    "https://gitlab.com/gitlab-org/cli/-/merge_requests/abc",
    "https://gitlab.com/cli/-/merge_requests/1",
    "https://gitlab.com/gitlab-org/../cli/-/merge_requests/1",
    "https://github.com/owner/repo/pull/1",
    "https://github.com/owner/repo/-/merge_requests/1",
    "ftp://gitlab.com/gitlab-org/cli/-/merge_requests/3931",
  ]) {
    assert.equal(await forge.matchUrl(url), null, url);
  }
  assert.deepEqual(run.calls, []);
});

test("takes a merge request URL only on a host glab is logged in to, and asks each host once", async () => {
  const { forge, run } = forgeReplaying([LOGGED_IN, NOT_LOGGED_IN]);

  assert.deepEqual(await forge.matchUrl(MR_3931.url), MR_3931);
  assert.deepEqual(await forge.matchUrl(`${MR_3931.url}/diffs`), MR_3931);
  await assert.rejects(
    forge.matchUrl("https://git.example.com/acme/app/-/merge_requests/7"),
    new ForgeError("glab is not logged in to git.example.com. Run `glab auth login --hostname git.example.com` on the daemon's host."),
  );

  assert.deepEqual(
    run.calls.map((call) => [call.file, ...call.args]),
    [
      [GLAB, "auth", "status", "--hostname", "gitlab.com"],
      [GLAB, "auth", "status", "--hostname", "git.example.com"],
    ],
  );
});

test("reads a merge request's metadata, diff refs, files, commits and linked issues through glab api", async () => {
  const { forge, run } = forgeReplaying(READ_MR);

  const mr = await forge.fetchChangeRequest(MR_3931);

  assert.deepEqual(
    run.calls.map((call) => ({ file: call.file, args: call.args, input: call.input })),
    [
      { file: GLAB, args: ["auth", "status", "--hostname", "gitlab.com"], input: undefined },
      { file: GLAB, args: ["api", "--hostname", "gitlab.com", "projects/gitlab-org%2Fcli"], input: undefined },
      { file: GLAB, args: ["api", "--hostname", "gitlab.com", "projects/34675721/merge_requests/3931"], input: undefined },
      {
        file: GLAB,
        args: [
          "api",
          "--hostname",
          "gitlab.com",
          "projects/34675721/merge_requests/3931/diffs?per_page=100",
          "--paginate",
          "--output",
          "ndjson",
        ],
        input: undefined,
      },
      { file: GLAB, args: ["api", "--hostname", "gitlab.com", "projects/34675721/merge_requests/3931/commits?per_page=100"], input: undefined },
      {
        file: GLAB,
        args: ["api", "--hostname", "gitlab.com", "projects/34675721/merge_requests/3931/closes_issues?per_page=25"],
        input: undefined,
      },
    ],
  );

  assert.equal(mr.ref, MR_3931);
  assert.equal(mr.title, "feat: mr note create support for internal notes/threads");
  assert.match(mr.description, /^## Description\n\nAdds support for internal notes/);
  assert.deepEqual(mr.author, { login: "gkepas", name: "Giannis Kepas" });
  assert.equal(mr.state, "merged");
  assert.equal(mr.isDraft, false);
  assert.deepEqual(
    {
      baseBranch: mr.baseBranch,
      headBranch: mr.headBranch,
      baseSha: mr.baseSha,
      startSha: mr.startSha,
      headSha: mr.headSha,
    },
    {
      baseBranch: "main",
      headBranch: "8557-mr-internal-notes",
      baseSha: "a34c75cf567863b8d4acbcf739625ca291a3c99d",
      startSha: "c1c0a9f1f0fd33d96b9aa47c690734e8628c6847",
      headSha: "8e1ef79fe55aae06f0c7246e550f8c30075b7564",
    },
  );
  // GitLab's own diffStatsSummary for !3931 says 284 and 10.
  assert.deepEqual({ additions: mr.additions, deletions: mr.deletions }, { additions: 284, deletions: 10 });

  assert.deepEqual(
    mr.commits.map(({ sha, headline, body, author }) => ({ sha: sha.slice(0, 8), headline, body, author })),
    [
      { sha: "942ec009", headline: "feat: mr note create supports internal notes", body: "", author: "Giannis Kepas" },
      { sha: "b1faf4bb", headline: "chore: apply doc suggestions", body: "", author: "Giannis Kepas" },
      { sha: "16426966", headline: "chore: use MarkFlagsMutuallyExclusive for flag checking", body: "", author: "Giannis Kepas" },
      { sha: "8e1ef79f", headline: "chore: Apply 1 suggestion(s) to 1 file(s)", body: "", author: "Ahmed Hemdan" },
    ],
  );
  assert.equal(mr.commits[0]?.authoredAt, "2026-09-17T13:23:29.000+03:00");
  assert.deepEqual(mr.commits.at(-1)?.parents, ["164269665533d8211f3d30effa7b28e317ed8b1d"]);

  assert.deepEqual(
    mr.linkedIssues.map(({ number, url, title, state }) => ({ number, url, title, state })),
    [
      {
        number: 8557,
        url: "https://gitlab.com/gitlab-org/cli/-/work_items/8557",
        title: "glab mr note create cannot post an internal note",
        state: "closed",
      },
    ],
  );
  assert.match(mr.linkedIssues[0]?.body ?? "", /^The GitLab API supports internal notes/);

  assert.deepEqual(
    mr.files.map(({ path, previousPath, status, additions, deletions }) => ({ path, previousPath, status, additions, deletions })),
    [
      { path: "docs/source/mr/note/create.md", previousPath: null, status: "modified", additions: 13, deletions: 0 },
      { path: "internal/commands/mr/mrutils/discussions.go", previousPath: null, status: "modified", additions: 30, deletions: 6 },
      { path: "internal/commands/mr/note/mr_note_create.go", previousPath: null, status: "modified", additions: 42, deletions: 4 },
      { path: "internal/commands/mr/note/mr_note_create_test.go", previousPath: null, status: "modified", additions: 199, deletions: 0 },
    ],
  );
  const patch = mr.files[0]?.patch ?? "";
  assert.match(patch, /^@@ -22,6 \+22,8 @@/);
  assert.equal(patch.endsWith("\n"), false, "the patch ends where GitHub's does");
});

test("keeps where a renamed file came from, and that a withheld or binary diff is no patch", async () => {
  const extra = [
    { old_path: "a.ts", new_path: "b.ts", new_file: false, renamed_file: true, deleted_file: false, diff: "" },
    { old_path: "new.ts", new_path: "new.ts", new_file: true, renamed_file: false, deleted_file: false, diff: "@@ -0,0 +1,2 @@\n+a\n+b\n" },
    { old_path: "gone.ts", new_path: "gone.ts", new_file: false, renamed_file: false, deleted_file: true, diff: "@@ -1 +0,0 @@\n-a\n" },
    { old_path: "big.json", new_path: "big.json", new_file: false, renamed_file: false, deleted_file: false, diff: "", too_large: true },
    { old_path: "logo.png", new_path: "logo.png", new_file: false, renamed_file: false, deleted_file: false, diff: "Binary files differ\n" },
  ];
  const script = [...READ_MR];
  script[3] = { stdout: fixture("diffs.ndjson") + extra.map((entry) => JSON.stringify(entry)).join("\n") };
  const { forge } = forgeReplaying(script);

  const mr = await forge.fetchChangeRequest(MR_3931);

  assert.deepEqual(mr.files.slice(4), [
    { path: "b.ts", previousPath: "a.ts", status: "renamed", additions: 0, deletions: 0, patch: null },
    { path: "new.ts", previousPath: null, status: "added", additions: 2, deletions: 0, patch: "@@ -0,0 +1,2 @@\n+a\n+b" },
    { path: "gone.ts", previousPath: null, status: "removed", additions: 0, deletions: 1, patch: "@@ -1 +0,0 @@\n-a" },
    { path: "big.json", previousPath: null, status: "modified", additions: 0, deletions: 0, patch: null },
    { path: "logo.png", previousPath: null, status: "modified", additions: 0, deletions: 0, patch: null },
  ]);
  assert.deepEqual({ additions: mr.additions, deletions: mr.deletions }, { additions: 286, deletions: 11 });
});

test("looks a project's numeric ID up once and addresses it by that ID after", async () => {
  const { forge, run } = forgeReplaying([
    ...READ_MR,
    { stdout: fixture("merge-request.json") },
    { stdout: fixture("diffs.ndjson") },
    { stdout: fixture("commits.json") },
    { stdout: fixture("closes-issues.json") },
  ]);

  await forge.fetchChangeRequest(MR_3931);
  await forge.fetchChangeRequest({ ...MR_3931, project: "GitLab-org/CLI" });

  const paths = run.calls.map((call) => call.args.find((arg) => arg.startsWith("projects/")) ?? call.args[0]);
  assert.equal(paths.filter((entry) => entry === "projects/gitlab-org%2Fcli").length, 1);
  assert.equal(paths.filter((entry) => entry === "auth").length, 1);
  assert.equal(paths.at(-4), "projects/34675721/merge_requests/3931");
});

test("encodes every slash of a subgroup path in the project lookup", async () => {
  const { forge, run } = forgeReplaying([LOGGED_IN, { stdout: '{"id":99}' }, { exitCode: 1, stderr: "glab: 404 Not found (HTTP 404)\n" }]);

  await assert.rejects(forge.fetchChangeRequest({ ...MR_3931, project: "acme/platform/uploader", number: 7 }));
  assert.deepEqual(run.calls.slice(1).map((call) => call.args.at(-1)), [
    "projects/acme%2Fplatform%2Fuploader",
    "projects/99/merge_requests/7",
  ]);
});

test("a merge request glab cannot find fails in glab's own words", async () => {
  const { forge, run } = forgeReplaying([
    LOGGED_IN,
    { stdout: fixture("project.json") },
    { exitCode: 1, stdout: fixture("merge-request-missing.json"), stderr: fixture("merge-request-missing.stderr") },
  ]);

  await assert.rejects(forge.fetchChangeRequest({ ...MR_3931, number: 999999 }), new ForgeError("glab failed: 404 Not found (HTTP 404)"));
  assert.equal(run.calls.length, 3, "the diffs are not asked for");
});

test("a merge request GitLab has no diff for yet says so", async () => {
  const noDiff = JSON.stringify({ ...JSON.parse(fixture("merge-request.json")), diff_refs: null });
  const { forge } = forgeReplaying([LOGGED_IN, { stdout: fixture("project.json") }, { stdout: noDiff }]);

  await assert.rejects(
    forge.fetchChangeRequest(MR_3931),
    new ForgeError(`GitLab has not worked out the diff of ${MR_3931.url} yet. Try again in a moment.`),
  );
});

test("never runs glab against a host it is not logged in to", async () => {
  const { forge, run } = forgeReplaying([NOT_LOGGED_IN]);

  await assert.rejects(forge.currentUser({ ...MR_3931, host: "git.example.com" }), ForgeError);
  assert.equal(run.calls.length, 1, "only the login check ran");
});

test("a glab that cannot run points at the setting", async () => {
  const { forge } = forgeReplaying([{ exitCode: null, spawnError: "spawn /usr/bin/glab ENOENT" }]);

  await assert.rejects(
    forge.matchUrl(MR_3931.url),
    new ForgeError('Could not run glab at "/usr/bin/glab" (spawn /usr/bin/glab ENOENT). Set the glab path in the Guided Review settings.'),
  );
});

test("glab runs without an agent's identity and without prompts", async () => {
  const { forge, run } = forgeReplaying([LOGGED_IN, { stdout: fixture("user.json") }]);

  await forge.currentUser(MR_3931);

  for (const call of run.calls) {
    assert.deepEqual(call.unsetEnv, ["PASEO_AGENT_ID", "GITLAB_BOT_IDENTITY"]);
    assert.equal(call.env?.GLAB_NO_PROMPT, "1");
    assert.equal(call.env?.GLAB_CHECK_UPDATE, "0");
  }
});

test("reads where a merge request's diff head is now, its state and its description, by the project's numeric ID", async () => {
  const { forge, run } = forgeReplaying([LOGGED_IN, { stdout: fixture("project.json") }, { stdout: fixture("merge-request.json") }]);

  assert.deepEqual(await forge.fetchHead(MR_3931), {
    headSha: "8e1ef79fe55aae06f0c7246e550f8c30075b7564",
    state: "merged",
    description: JSON.parse(fixture("merge-request.json")).description,
  });
  assert.deepEqual(run.calls.at(-1)?.args, ["api", "--hostname", "gitlab.com", "projects/34675721/merge_requests/3931"]);
});

test("counts the commits since an earlier head from the merge request's latest, newest first", async () => {
  const commits = (ids: string[]) => ({ stdout: JSON.stringify(ids.map((id) => ({ id }))) });
  const full = Array.from({ length: 100 }, (_, index) => `c${index}`);
  const { forge, run } = forgeReplaying([LOGGED_IN, { stdout: fixture("project.json") }, commits(["d", "c", "b", "a"]), commits(["d", "c"]), commits(full)]);

  assert.deepEqual(await forge.commitsSince(MR_3931, "b"), { kind: "after", count: 2 });
  assert.deepEqual(await forge.commitsSince(MR_3931, "b"), { kind: "rewritten" });
  assert.equal(await forge.commitsSince(MR_3931, "b"), null);
  assert.deepEqual(run.calls.at(-1)?.args, ["api", "--hostname", "gitlab.com", "projects/34675721/merge_requests/3931/commits?per_page=100"]);
});

test("lists the merge requests each commit belongs to, one read per commit", async () => {
  const head = "8e1ef79fe55aae06f0c7246e550f8c30075b7564";
  const parent = "164269665533d8211f3d30effa7b28e317ed8b1d";
  const { forge, run } = forgeReplaying([LOGGED_IN, { stdout: fixture("project.json") }, { stdout: fixture("commit-merge-requests.json") }, { stdout: "[]" }]);

  const listed = await forge.commitChangeRequests(MR_3931, [head, parent]);

  assert.deepEqual(Object.fromEntries(listed), {
    [head]: [
      {
        number: 3931,
        url: "https://gitlab.com/gitlab-org/cli/-/merge_requests/3931",
        title: "feat: mr note create support for internal notes/threads",
        state: "merged",
        sourceBranch: "8557-mr-internal-notes",
        targetBranch: "main",
      },
    ],
    [parent]: [],
  });
  assert.deepEqual(
    run.calls.slice(2).map((call) => call.args.at(-1)),
    [`projects/34675721/repository/commits/${head}/merge_requests`, `projects/34675721/repository/commits/${parent}/merge_requests`],
  );
});

test("a merge request whose diff GitLab has not worked out yet has its source branch's head", async () => {
  const mr = { ...JSON.parse(fixture("merge-request.json")), state: "opened", diff_refs: null, sha: "d".repeat(40) };
  const { forge } = forgeReplaying([LOGGED_IN, { stdout: fixture("project.json") }, { stdout: JSON.stringify(mr) }]);

  assert.deepEqual(await forge.fetchHead(MR_3931), { headSha: "d".repeat(40), state: "open", description: JSON.parse(fixture("merge-request.json")).description });
});

test("identifies the current user on the merge request's host", async () => {
  const { forge, run } = forgeReplaying([LOGGED_IN, { stdout: fixture("user.json") }]);

  assert.deepEqual(await forge.currentUser(MR_3931), { login: "quack-overflow", name: "QuackOverflow" });
  assert.deepEqual(run.calls.at(-1)?.args, ["api", "--hostname", "gitlab.com", "user"]);
});

test("clones the merge request's repository with glab", async () => {
  const { forge, run } = forgeReplaying([LOGGED_IN, {}]);

  await forge.cloneRepository(MR_3931, "/data/clones/gitlab.com/gitlab-org/cli");

  assert.deepEqual(run.calls.at(-1)?.args, ["repo", "clone", "https://gitlab.com/gitlab-org/cli", "/data/clones/gitlab.com/gitlab-org/cli"]);
});

test("a failure glab prints as a box is told in its words, not its title", async () => {
  const { forge } = forgeReplaying([LOGGED_IN, NOT_LOGGED_IN]);

  await assert.rejects(
    forge.cloneRepository(MR_3931, "/data/clones/gitlab.com/gitlab-org/cli"),
    new ForgeError(
      "glab failed: gitlab.example.invalid has not been authenticated with glab; run `glab auth login --hostname gitlab.example.invalid` to authenticate.",
    ),
  );
});

test("finds the open merge request whose source branch is a workspace's branch, by the project's numeric ID", async () => {
  // Recorded for gitlab-org/cli's 7699-follow-up-validate-spec-for-components, which has !3967 open.
  const { forge, run } = forgeReplaying([LOGGED_IN, { stdout: fixture("project.json") }, { stdout: fixture("merge-requests-for-branch.json") }]);

  assert.deepEqual(await forge.findByBranch({ host: "gitlab.com", project: "gitlab-org/cli" }, "7699-follow-up-validate-spec-for-components"), [
    {
      ref: {
        forge: "gitlab",
        host: "gitlab.com",
        project: "gitlab-org/cli",
        number: 3967,
        url: "https://gitlab.com/gitlab-org/cli/-/merge_requests/3967",
      },
      title: "chore: spec validation added",
      author: "donaldcook",
      headSha: JSON.parse(fixture("merge-requests-for-branch.json"))[0].sha,
    },
  ]);
  assert.deepEqual(run.calls.at(-1)?.args, [
    "api",
    "--hostname",
    "gitlab.com",
    "projects/34675721/merge_requests?source_branch=7699-follow-up-validate-spec-for-components&state=opened&per_page=20",
  ]);
});

test("a branch name is encoded in the merge request query, and github.com is not GitLab's", async () => {
  const { forge, run } = forgeReplaying([LOGGED_IN, { stdout: fixture("project.json") }, { stdout: "[]" }]);

  assert.deepEqual(await forge.findByBranch({ host: "gitlab.com", project: "gitlab-org/cli" }, "feat/a&b"), []);
  assert.equal(await forge.findByBranch({ host: "github.com", project: "gitlab-org/cli" }, "main"), null);
  assert.equal(run.calls.at(-1)?.args.at(-1), "projects/34675721/merge_requests?source_branch=feat%2Fa%26b&state=opened&per_page=20");
  assert.equal(run.calls.length, 3);
});

test("a repository on a host glab is not logged in to is turned down before anything is asked of it", async () => {
  const { forge, run } = forgeReplaying([NOT_LOGGED_IN]);

  await assert.rejects(forge.findByBranch({ host: "gitlab.example.com", project: "acme/app" }, "main"), ForgeError);
  assert.equal(run.calls.length, 1, "only the login check ran");
});

// Drafts. Nothing here is recorded, since a draft note is a write to a real MR: `draft-notes.ndjson`,
// `discussions.ndjson` and the answers below are built by hand from GitLab's draft notes and
// discussions API docs, on !3931's diff refs and files.

const MR_3931_TARGET: DraftTarget = {
  ref: MR_3931,
  baseSha: "a34c75cf567863b8d4acbcf739625ca291a3c99d",
  startSha: "c1c0a9f1f0fd33d96b9aa47c690734e8628c6847",
  headSha: "8e1ef79fe55aae06f0c7246e550f8c30075b7564",
};
const DIFF_REFS = { base_sha: MR_3931_TARGET.baseSha, start_sha: MR_3931_TARGET.startSha, head_sha: MR_3931_TARGET.headSha };

/** Lines of the first hunk of discussions.go in !3931, `@@ -143,28 +143,52 @@`, as `parsePatch` reads them. */
const GO_PATH = "internal/commands/mr/mrutils/discussions.go";
const GO = { path: GO_PATH, previousPath: null };
const GO_PATHS = { old_path: GO_PATH, new_path: GO_PATH };
/** `echo -n internal/commands/mr/mrutils/discussions.go | sha1sum` */
const GO_SHA1 = "58b4176ff8bffa189fe52755b949fc37c46ca010";
const CONTEXT_145: AnchorLine = { kind: "context", oldLine: 145, newLine: 145, oldPos: 145, newPos: 145 };
const ADDED_146: AnchorLine = { kind: "added", oldLine: null, newLine: 146, oldPos: 146, newPos: 146 };
const ADDED_147: AnchorLine = { kind: "added", oldLine: null, newLine: 147, oldPos: 146, newPos: 147 };
const REMOVED_148: AnchorLine = { kind: "removed", oldLine: 148, newLine: null, oldPos: 148, newPos: 159 };
const MD_PATH = "docs/source/mr/note/create.md";

const DRAFT_NOTES = "projects/34675721/merge_requests/3931/draft_notes";
const JSON_BODY = ["--header", "Content-Type: application/json", "--input", "-"];

/** The first `count` draft notes of the hand-built listing. */
function draftNotesFixture(count?: number): string {
  return fixture("draft-notes.ndjson").split("\n").filter((line) => line !== "").slice(0, count).join("\n");
}

/** A draft note as GitLab answers with one: its entity's every field, the position's unset ones null. */
function draftNote(id: number, note: string, position: Record<string, unknown> | null): ScriptedResult {
  const kept =
    position === null
      ? null
      : { old_path: null, new_path: null, old_line: null, new_line: null, line_range: null, ...position };
  return {
    stdout: JSON.stringify({
      id,
      author_id: 21230898,
      merge_request_id: 533339747,
      resolve_discussion: false,
      discussion_id: null,
      note,
      commit_id: null,
      line_code: null,
      position: kept,
    }),
  };
}

test("the anchor lines above are the diff's own, with GitLab's running counters", async () => {
  const { forge } = forgeReplaying(READ_MR);
  const files = (await forge.fetchChangeRequest(MR_3931)).files;
  const at = (line: LineRef) => {
    const anchor = anchorAt(files, { kind: "line", path: GO_PATH, line });
    return anchor.kind === "line" ? anchor.line : null;
  };

  assert.deepEqual(at({ side: "new", line: 145 }), CONTEXT_145);
  assert.deepEqual(at({ side: "new", line: 146 }), ADDED_146);
  assert.deepEqual(at({ side: "new", line: 147 }), ADDED_147);
  assert.deepEqual(at({ side: "old", line: 148 }), REMOVED_148);
});

test("lists the viewer's draft notes by the project's numeric ID, a reply where its thread is, and an MR-level one as general", async () => {
  const { forge, run } = forgeReplaying([
    LOGGED_IN,
    { stdout: fixture("project.json") },
    { stdout: fixture("draft-notes.ndjson") },
    { stdout: fixture("discussions.ndjson") },
  ]);

  const drafts = await forge.listDrafts(MR_3931);

  assert.deepEqual(
    run.calls.slice(1).map((call) => call.args),
    [
      ["api", "--hostname", "gitlab.com", "projects/gitlab-org%2Fcli"],
      ["api", "--hostname", "gitlab.com", `${DRAFT_NOTES}?per_page=100`, "--paginate", "--output", "ndjson"],
      ["api", "--hostname", "gitlab.com", "projects/34675721/merge_requests/3931/discussions?per_page=100", "--paginate", "--output", "ndjson"],
    ],
  );
  assert.deepEqual(drafts, [
    // Started on the web, which sends a one-line `line_range` even for a single line.
    { id: "101", body: "Why a second lookup here?", location: { kind: "line", path: GO_PATH, line: { side: "new", line: 146 } } },
    {
      id: "102",
      body: "This block reads well.",
      location: { kind: "range", path: GO_PATH, start: { side: "new", line: 145 }, end: { side: "new", line: 147 } },
    },
    { id: "103", body: "Was this message used anywhere else?", location: { kind: "line", path: GO_PATH, line: { side: "old", line: 148 } } },
    { id: "104", body: "The docs could mention the flag earlier.", location: { kind: "file", path: MD_PATH } },
    // Its position comes back all null: a thread on the merge request as a whole once published.
    { id: "105", body: "Overall this looks good.", location: { kind: "general" } },
    { id: "106", body: "Agreed, and the same goes for replies.", location: { kind: "line", path: MD_PATH, line: { side: "new", line: 25 } } },
  ]);
});

test("without a reply among the drafts the MR's discussions are not read", async () => {
  const { forge, run } = forgeReplaying([LOGGED_IN, { stdout: fixture("project.json") }, { stdout: draftNotesFixture(5) }]);

  assert.deepEqual((await forge.listDrafts(MR_3931)).map((draft) => draft.id), ["101", "102", "103", "104", "105"]);
  assert.equal(run.calls.length, 3);
});

test("each anchor becomes the draft note position GitLab anchors it by, sent as JSON to the numeric project ID", async () => {
  const range = (start: AnchorLine, end: AnchorLine): DraftAnchor => ({ kind: "range", ...GO, start, end });
  const cases: { anchor: DraftAnchor; position: Record<string, unknown>; location: unknown }[] = [
    {
      anchor: { kind: "line", ...GO, line: ADDED_146 },
      position: { position_type: "text", ...DIFF_REFS, ...GO_PATHS, new_line: 146 },
      location: { kind: "line", path: GO_PATH, line: { side: "new", line: 146 } },
    },
    {
      anchor: { kind: "line", ...GO, line: REMOVED_148 },
      position: { position_type: "text", ...DIFF_REFS, ...GO_PATHS, old_line: 148 },
      location: { kind: "line", path: GO_PATH, line: { side: "old", line: 148 } },
    },
    {
      anchor: { kind: "line", ...GO, line: CONTEXT_145 },
      position: { position_type: "text", ...DIFF_REFS, ...GO_PATHS, old_line: 145, new_line: 145 },
      location: { kind: "line", path: GO_PATH, line: { side: "new", line: 145 } },
    },
    {
      anchor: range(CONTEXT_145, ADDED_147),
      position: {
        position_type: "text",
        ...DIFF_REFS,
        ...GO_PATHS,
        new_line: 147,
        line_range: {
          start: { line_code: `${GO_SHA1}_145_145`, type: null, old_line: 145, new_line: 145 },
          end: { line_code: `${GO_SHA1}_146_147`, type: "new", old_line: null, new_line: 147 },
        },
      },
      location: { kind: "range", path: GO_PATH, start: { side: "new", line: 145 }, end: { side: "new", line: 147 } },
    },
    {
      anchor: range(ADDED_146, REMOVED_148),
      position: {
        position_type: "text",
        ...DIFF_REFS,
        ...GO_PATHS,
        old_line: 148,
        line_range: {
          start: { line_code: `${GO_SHA1}_146_146`, type: "new", old_line: null, new_line: 146 },
          end: { line_code: `${GO_SHA1}_148_159`, type: "old", old_line: 148, new_line: null },
        },
      },
      location: { kind: "range", path: GO_PATH, start: { side: "new", line: 146 }, end: { side: "old", line: 148 } },
    },
    {
      anchor: { kind: "file", path: "cmd/new.go", previousPath: "cmd/old.go" },
      position: { position_type: "file", ...DIFF_REFS, old_path: "cmd/old.go", new_path: "cmd/new.go" },
      location: { kind: "file", path: "cmd/new.go" },
    },
  ];

  for (const { anchor, position, location } of cases) {
    const { forge, run } = forgeReplaying([LOGGED_IN, { stdout: fixture("project.json") }, draftNote(201, "Why?", position)]);

    const draft = await forge.createDraft(MR_3931_TARGET, { anchor, body: "Why?" });

    const call = run.calls.at(-1)!;
    assert.deepEqual(call.args, ["api", "--hostname", "gitlab.com", "--method", "POST", ...JSON_BODY, DRAFT_NOTES], anchor.kind);
    assert.deepEqual(JSON.parse(call.input!), { note: "Why?", position }, JSON.stringify(anchor));
    assert.deepEqual(draft, { id: "201", body: "Why?", location });
    assert.equal(run.calls.length, 3, "nothing is taken back");
  }
});

test("a draft GitLab kept somewhere other than where it was put is deleted again, and the reviewer told", async () => {
  const sent = { position_type: "text", ...DIFF_REFS, ...GO_PATHS, old_line: 145, new_line: 145 };
  for (const kept of [
    // A body read as a form loses its position, which leaves an MR-level draft.
    null,
    { position_type: "text", ...DIFF_REFS, ...GO_PATHS, new_line: 145 },
    { ...sent, head_sha: "73472a4e0000000000000000000000000000000" },
  ]) {
    const { forge, run } = forgeReplaying([LOGGED_IN, { stdout: fixture("project.json") }, draftNote(202, "Why?", kept), {}]);

    await assert.rejects(
      forge.createDraft(MR_3931_TARGET, { anchor: { kind: "line", ...GO, line: CONTEXT_145 }, body: "Why?" }),
      new ForgeError("GitLab did not keep the comment where it was put, so the draft was deleted again. This GitLab may not take comments of this kind."),
    );
    assert.deepEqual(run.calls.at(-1)?.args, ["api", "--hostname", "gitlab.com", "--method", "DELETE", `${DRAFT_NOTES}/202`]);
  }

  // A range GitLab kept as its last line alone is not the range either.
  const rangeSent = positionOfRange();
  const { forge, run } = forgeReplaying([
    LOGGED_IN,
    { stdout: fixture("project.json") },
    draftNote(203, "Why?", { ...rangeSent, line_range: null }),
    {},
  ]);
  await assert.rejects(forge.createDraft(MR_3931_TARGET, { anchor: { kind: "range", ...GO, start: CONTEXT_145, end: ADDED_147 }, body: "Why?" }), ForgeError);
  assert.deepEqual(run.calls.at(-1)?.args.at(-1), `${DRAFT_NOTES}/203`);
});

test("a general draft is an MR-level draft note, sent with no position at all", async () => {
  const { forge, run } = forgeReplaying([LOGGED_IN, { stdout: fixture("project.json") }, draftNote(205, "About the pager: why a second lookup?", null)]);

  const draft = await forge.createDraft(MR_3931_TARGET, { anchor: { kind: "general" }, body: "About the pager: why a second lookup?" });

  const call = run.calls.at(-1)!;
  assert.deepEqual(call.args, ["api", "--hostname", "gitlab.com", "--method", "POST", ...JSON_BODY, DRAFT_NOTES]);
  assert.deepEqual(JSON.parse(call.input!), { note: "About the pager: why a second lookup?" });
  assert.deepEqual(draft, { id: "205", body: "About the pager: why a second lookup?", location: { kind: "general" } });
  assert.equal(run.calls.length, 3, "nothing is taken back");
});

function positionOfRange(): Record<string, unknown> {
  return {
    position_type: "text",
    ...DIFF_REFS,
    ...GO_PATHS,
    new_line: 147,
    line_range: {
      start: { line_code: `${GO_SHA1}_145_145`, type: null, old_line: 145, new_line: 145 },
      end: { line_code: `${GO_SHA1}_146_147`, type: "new", old_line: null, new_line: 147 },
    },
  };
}

test("a misplaced draft that cannot be deleted either is left for the reviewer to delete, in so many words", async () => {
  const { forge } = forgeReplaying([
    LOGGED_IN,
    { stdout: fixture("project.json") },
    draftNote(204, "Why?", null),
    { exitCode: 1, stderr: "glab: 404 Not found (HTTP 404)\n" },
  ]);

  await assert.rejects(
    forge.createDraft(MR_3931_TARGET, { anchor: { kind: "file", ...GO }, body: "Why?" }),
    new ForgeError(
      "GitLab did not keep the comment where it was put, and deleting the misplaced draft failed too (glab failed: 404 Not found (HTTP 404)). Delete it on the merge request's page before submitting.",
    ),
  );
});

test("an edit sends the draft's own position back with the new text, since one sent without it is wiped", async () => {
  const [, rangeDraft, , , mrLevelDraft] = draftNotesFixture().split("\n");
  const { forge, run } = forgeReplaying([
    LOGGED_IN,
    { stdout: fixture("project.json") },
    { stdout: rangeDraft },
    { stdout: rangeDraft },
    { stdout: mrLevelDraft },
    { stdout: mrLevelDraft },
  ]);

  await forge.updateDraft(MR_3931, "102", "This block reads very well.");
  await forge.updateDraft(MR_3931, "105", "Overall this looks great.");

  assert.deepEqual(
    run.calls.slice(2).map((call) => call.args),
    [
      ["api", "--hostname", "gitlab.com", `${DRAFT_NOTES}/102`],
      ["api", "--hostname", "gitlab.com", "--method", "PUT", ...JSON_BODY, `${DRAFT_NOTES}/102`],
      ["api", "--hostname", "gitlab.com", `${DRAFT_NOTES}/105`],
      ["api", "--hostname", "gitlab.com", "--method", "PUT", ...JSON_BODY, `${DRAFT_NOTES}/105`],
    ],
  );
  assert.deepEqual(JSON.parse(run.calls[3]!.input!), { note: "This block reads very well.", position: JSON.parse(rangeDraft!).position });
  // An MR-level draft's all-null position is not one GitLab would take back.
  assert.deepEqual(JSON.parse(run.calls[5]!.input!), { note: "Overall this looks great." });
});

test("deletes a draft note by its ID, and takes nothing but a GitLab ID", async () => {
  const { forge, run } = forgeReplaying([LOGGED_IN, { stdout: fixture("project.json") }, {}]);

  await forge.deleteDraft(MR_3931, "103");
  assert.deepEqual(run.calls.at(-1)?.args, ["api", "--hostname", "gitlab.com", "--method", "DELETE", `${DRAFT_NOTES}/103`]);

  for (const id of ["PRRC_kwDOUFGNmM6", "103/publish", "../1", "0", ""]) {
    await assert.rejects(forge.deleteDraft(MR_3931, id), ForgeError, id);
    await assert.rejects(forge.updateDraft(MR_3931, id, "text"), ForgeError, id);
  }
  assert.equal(run.calls.length, 3, "nothing more ran");
});

// Submitting and discarding. Nothing here is recorded, since every call but the reads publishes to or
// deletes from a real MR: the answers are built by hand from GitLab's REST and GraphQL docs, with
// `user.json` as the viewer.

const MERGE_REQUEST = "projects/34675721/merge_requests/3931";
const BODY = "Reads well.\n\nOne question on the discussions lookup.";

/** `GET version` on a GitLab of that version. */
function version(number: string): ScriptedResult {
  return { stdout: JSON.stringify({ version: number, revision: "6f3e1c2a", enterprise: true }) };
}

/** `GET …/reviewers`, with the viewer (`user.json`'s `quack-overflow`) in `viewerState`, or not a reviewer at all. */
function reviewers(viewerState: string | null): ScriptedResult {
  const reviewer = (id: number, username: string, state: string) => ({
    user: { id, username, name: username, state: "active", web_url: `https://gitlab.com/${username}` },
    state,
    created_at: "2026-09-28T09:00:00.000Z",
  });
  const list = [reviewer(21230898, "ahmed.hemdan", "approved")];
  if (viewerState !== null) list.push(reviewer(42323707, "quack-overflow", viewerState));
  return { stdout: JSON.stringify(list) };
}

/** `mergeRequestRequestChanges`' answer: HTTP 200 whether it worked or not, with its `errors`. */
function requestedChanges(errors: string[] = []): ScriptedResult {
  return { stdout: JSON.stringify({ data: { mergeRequestRequestChanges: { errors, mergeRequest: errors.length ? null : { iid: "3931" } } } }) };
}

const REQUEST_CHANGES_CALL = [
  "api",
  "--hostname",
  "gitlab.com",
  "graphql",
  "-f",
  `query=${REQUEST_CHANGES_MUTATION}`,
  "-f",
  "projectPath=gitlab-org/cli",
  "-f",
  "iid=3931",
];

/** Every call after the login check, as its arguments followed, for a write, by the JSON it sent. */
function sent(run: { calls: { args: readonly string[]; input?: string }[] }): unknown[][] {
  return run.calls.slice(1).map((call) => (call.input === undefined ? [...call.args] : [...call.args, JSON.parse(call.input)]));
}

const done = (id: string, label: string) => ({ id, label, status: "done", message: null });

test("a request for changes publishes the drafts with the body and the state, and sets the state through GraphQL when it did not take", async () => {
  const { forge, run } = forgeReplaying([
    LOGGED_IN,
    version("19.5.0-pre"),
    { stdout: fixture("project.json") },
    {},
    { stdout: fixture("user.json") },
    reviewers("reviewed"),
    requestedChanges(),
  ]);

  const outcome = await forge.submitReview(MR_3931_TARGET, { verdict: "request-changes", body: BODY, approveHeadSha: MR_3931_TARGET.headSha });

  assert.deepEqual(sent(run), [
    ["api", "--hostname", "gitlab.com", "version"],
    ["api", "--hostname", "gitlab.com", "projects/gitlab-org%2Fcli"],
    ["api", "--hostname", "gitlab.com", "--method", "POST", ...JSON_BODY, `${DRAFT_NOTES}/bulk_publish`, { note: BODY, reviewer_state: "requested_changes" }],
    ["api", "--hostname", "gitlab.com", "user"],
    ["api", "--hostname", "gitlab.com", `${MERGE_REQUEST}/reviewers`],
    REQUEST_CHANGES_CALL,
  ]);
  assert.deepEqual(outcome, {
    published: true,
    steps: [done("publish", "Publish your drafts and the review body"), done("request-changes", "Request changes")],
  });
});

test("a request for changes GitLab recorded with the publish is not sent again", async () => {
  const { forge, run } = forgeReplaying([
    LOGGED_IN,
    version("19.2.0"),
    { stdout: fixture("project.json") },
    {},
    { stdout: fixture("user.json") },
    reviewers("requested_changes"),
  ]);

  const outcome = await forge.submitReview(MR_3931_TARGET, { verdict: "request-changes", body: BODY, approveHeadSha: MR_3931_TARGET.headSha });

  assert.equal(run.calls.length, 6, "no GraphQL call");
  assert.deepEqual(sent(run)[2]?.at(-1), { note: BODY, reviewer_state: "requested_changes" });
  assert.deepEqual(outcome, {
    published: true,
    steps: [done("publish", "Publish your drafts and the review body"), done("request-changes", "Request changes")],
  });
});

test("lists the files changed between two commits, a renamed file's both paths, and none when GitLab timed out", async () => {
  const from = "942ec00911f34e52b2834c0a1bfea1b509574b15";
  const to = "8e1ef79fe55aae06f0c7246e550f8c30075b7564";
  const renamed = JSON.stringify({ compare_timeout: false, diffs: [{ old_path: "a.go", new_path: "b.go" }] });
  const { forge, run } = forgeReplaying([
    LOGGED_IN,
    { stdout: fixture("project.json") },
    { stdout: fixture("compare.json") },
    { stdout: renamed },
    { stdout: JSON.stringify({ compare_timeout: true, diffs: [] }) },
  ]);

  assert.deepEqual(await forge.changedPaths(MR_3931, from, to), [
    "docs/source/mr/note/create.md",
    "internal/commands/mr/note/mr_note_create.go",
    "internal/commands/mr/note/mr_note_create_test.go",
  ]);
  assert.deepEqual(await forge.changedPaths(MR_3931, from, to), ["a.go", "b.go"]);
  assert.equal(await forge.changedPaths(MR_3931, from, to), null);
  assert.deepEqual(run.calls[2]?.args, ["api", "--hostname", "gitlab.com", `projects/34675721/repository/compare?from=${from}&to=${to}&straight=true`]);
});

test("a discussion on the merge request as a whole is a thread of its own, the text sent as JSON", async () => {
  const { forge, run } = forgeReplaying([LOGGED_IN, { stdout: fixture("project.json") }, { stdout: JSON.stringify({ id: "abc", notes: [] }) }]);

  await forge.startDiscussion(MR_3931, BODY);

  assert.deepEqual(sent(run).at(-1), ["api", "--hostname", "gitlab.com", "--method", "POST", ...JSON_BODY, `${MERGE_REQUEST}/discussions`, { body: BODY }]);
});

test("a GitLab older than 19.2, which drops the body and the state on publish, gets the body as an MR note and the state through GraphQL", async () => {
  const { forge, run } = forgeReplaying([
    LOGGED_IN,
    version("18.11.2-ee"),
    { stdout: fixture("project.json") },
    {},
    { stdout: JSON.stringify({ id: 900, body: BODY, system: false }) },
    { stdout: fixture("user.json") },
    reviewers(null),
    requestedChanges(),
  ]);

  const outcome = await forge.submitReview(MR_3931_TARGET, { verdict: "request-changes", body: BODY, approveHeadSha: MR_3931_TARGET.headSha });

  assert.deepEqual(sent(run).slice(2), [
    // No `note`: were this GitLab to take it after all, the body would go out twice.
    ["api", "--hostname", "gitlab.com", "--method", "POST", ...JSON_BODY, `${DRAFT_NOTES}/bulk_publish`, { reviewer_state: "requested_changes" }],
    ["api", "--hostname", "gitlab.com", "--method", "POST", ...JSON_BODY, `${MERGE_REQUEST}/notes`, { body: BODY }],
    ["api", "--hostname", "gitlab.com", "user"],
    ["api", "--hostname", "gitlab.com", `${MERGE_REQUEST}/reviewers`],
    REQUEST_CHANGES_CALL,
  ]);
  assert.deepEqual(outcome, {
    published: true,
    steps: [done("publish", "Publish your drafts"), done("note", "Post the review body"), done("request-changes", "Request changes")],
  });
});

test("a GitLab whose version cannot be read is taken for an old one, so the body is posted on its own rather than lost", async () => {
  const { forge, run } = forgeReplaying([
    LOGGED_IN,
    { exitCode: 1, stderr: "glab: 403 Forbidden (HTTP 403)\n" },
    { stdout: fixture("project.json") },
    {},
    {},
    { stdout: fixture("user.json") },
    reviewers("reviewed"),
  ]);

  const outcome = await forge.submitReview(MR_3931_TARGET, { verdict: "comment", body: BODY, approveHeadSha: MR_3931_TARGET.headSha });

  assert.deepEqual(sent(run).slice(2), [
    ["api", "--hostname", "gitlab.com", "--method", "POST", ...JSON_BODY, `${DRAFT_NOTES}/bulk_publish`, { reviewer_state: "reviewed" }],
    ["api", "--hostname", "gitlab.com", "--method", "POST", ...JSON_BODY, `${MERGE_REQUEST}/notes`, { body: BODY }],
    ["api", "--hostname", "gitlab.com", "user"],
    ["api", "--hostname", "gitlab.com", `${MERGE_REQUEST}/reviewers`],
  ]);
  assert.deepEqual(outcome, {
    published: true,
    steps: [done("publish", "Publish your drafts"), done("note", "Post the review body"), done("reviewer-state", "Confirm your reviewer state")],
  });
});

test("an approval publishes the drafts as reviewed, approves the head it was given, and confirms the state in the reviewer list", async () => {
  const { forge, run } = forgeReplaying([
    LOGGED_IN,
    version("19.5.0-pre"),
    { stdout: fixture("project.json") },
    {},
    { stdout: JSON.stringify({ id: 533339747, iid: 3931, approved: true, user_has_approved: true }) },
    { stdout: fixture("user.json") },
    reviewers("approved"),
  ]);

  const outcome = await forge.submitReview(MR_3931_TARGET, { verdict: "approve", body: BODY, approveHeadSha: MR_3931_TARGET.headSha });

  assert.deepEqual(sent(run).slice(2), [
    ["api", "--hostname", "gitlab.com", "--method", "POST", ...JSON_BODY, `${DRAFT_NOTES}/bulk_publish`, { note: BODY, reviewer_state: "reviewed" }],
    ["api", "--hostname", "gitlab.com", "--method", "POST", ...JSON_BODY, `${MERGE_REQUEST}/approve`, { sha: MR_3931_TARGET.headSha }],
    ["api", "--hostname", "gitlab.com", "user"],
    ["api", "--hostname", "gitlab.com", `${MERGE_REQUEST}/reviewers`],
  ]);
  assert.deepEqual(outcome, {
    published: true,
    steps: [done("publish", "Publish your drafts and the review body"), done("approve", "Approve"), done("reviewer-state", "Confirm your reviewer state")],
  });
});

test("a comment without a body publishes the drafts as reviewed, without asking the version, and says a viewer who is no reviewer has no state", async () => {
  const { forge, run } = forgeReplaying([LOGGED_IN, { stdout: fixture("project.json") }, {}, { stdout: fixture("user.json") }, reviewers(null)]);

  const outcome = await forge.submitReview(MR_3931_TARGET, { verdict: "comment", body: "", approveHeadSha: MR_3931_TARGET.headSha });

  assert.deepEqual(sent(run), [
    ["api", "--hostname", "gitlab.com", "projects/gitlab-org%2Fcli"],
    ["api", "--hostname", "gitlab.com", "--method", "POST", ...JSON_BODY, `${DRAFT_NOTES}/bulk_publish`, { reviewer_state: "reviewed" }],
    ["api", "--hostname", "gitlab.com", "user"],
    ["api", "--hostname", "gitlab.com", `${MERGE_REQUEST}/reviewers`],
  ]);
  assert.deepEqual(outcome, {
    published: true,
    steps: [
      done("publish", "Publish your drafts"),
      {
        id: "reviewer-state",
        label: "Confirm your reviewer state",
        status: "done",
        message: "You are not one of the merge request's reviewers, so GitLab keeps no reviewer state for you.",
      },
    ],
  });
});

test("an Approve or a Comment whose state did not take, or whose reviewer list cannot be read, is a failed step, and nothing is set in its place", async () => {
  const cases = [
    {
      verdict: "comment" as const,
      answers: [{ stdout: fixture("user.json") }, reviewers("unreviewed")],
      message: "GitLab lists you as not reviewed yet, not reviewed. Set your reviewer state on the merge request's page.",
    },
    {
      verdict: "approve" as const,
      answers: [{ stdout: JSON.stringify({ approved: true }) }, { stdout: fixture("user.json") }, reviewers("requested_changes")],
      message: "GitLab lists you as requesting changes, not approved. Set your reviewer state on the merge request's page.",
    },
    {
      verdict: "comment" as const,
      answers: [{ stdout: fixture("user.json") }, { exitCode: 1, stderr: "glab: 404 Not found (HTTP 404)\n" }],
      message: "Could not read the merge request's reviewers to confirm your state: glab failed: 404 Not found (HTTP 404)",
    },
  ];
  for (const { verdict, answers, message } of cases) {
    const { forge, run } = forgeReplaying([LOGGED_IN, { stdout: fixture("project.json") }, {}, ...answers]);

    const outcome = await forge.submitReview(MR_3931_TARGET, { verdict, body: "", approveHeadSha: MR_3931_TARGET.headSha });

    assert.equal(run.calls.length, 3 + answers.length, "no GraphQL call");
    assert.equal(outcome.published, true);
    assert.deepEqual(outcome.steps.at(-1), { id: "reviewer-state", label: "Confirm your reviewer state", status: "failed", message });
  }
});

test("a request for changes the GraphQL mutation turns down with HTTP 200 and errors is a failed step, after the drafts landed", async () => {
  const { forge } = forgeReplaying([
    LOGGED_IN,
    version("17.11.3-ee"),
    { stdout: fixture("project.json") },
    {},
    {},
    { stdout: fixture("user.json") },
    reviewers(null),
    requestedChanges(["Reviewer not found"]),
  ]);

  const outcome = await forge.submitReview(MR_3931_TARGET, { verdict: "request-changes", body: BODY, approveHeadSha: MR_3931_TARGET.headSha });

  assert.equal(outcome.published, true);
  assert.deepEqual(outcome.steps.at(-1), {
    id: "request-changes",
    label: "Request changes",
    status: "failed",
    message: "GitLab did not record your request for changes: Reviewer not found. Request changes on the merge request's page.",
  });
});

test("a request for changes whose reviewer list cannot be read is set through GraphQL all the same", async () => {
  const { forge, run } = forgeReplaying([
    LOGGED_IN,
    { stdout: fixture("project.json") },
    {},
    { stdout: fixture("user.json") },
    { exitCode: 1, stderr: "glab: 404 Not found (HTTP 404)\n" },
    { stdout: JSON.stringify({ errors: [{ message: "Field 'mergeRequestRequestChanges' doesn't exist on type 'Mutation'" }] }) },
  ]);

  const outcome = await forge.submitReview(MR_3931_TARGET, { verdict: "request-changes", body: "", approveHeadSha: MR_3931_TARGET.headSha });

  assert.deepEqual(run.calls.at(-1)?.args, REQUEST_CHANGES_CALL);
  assert.deepEqual(
    outcome.steps.map((step) => [step.id, step.status]),
    [
      ["publish", "done"],
      ["request-changes", "failed"],
    ],
  );
  assert.match(outcome.steps[1]!.message!, /doesn't exist/);
});

test("a publish GitLab turns down leaves the drafts pending and tries nothing after it", async () => {
  for (const verdict of ["approve", "request-changes"] as const) {
    const { forge, run } = forgeReplaying([
      LOGGED_IN,
      version("18.4.0"),
      { stdout: fixture("project.json") },
      { exitCode: 1, stderr: "glab: 403 Forbidden (HTTP 403)\n" },
    ]);

    const outcome = await forge.submitReview(MR_3931_TARGET, { verdict, body: BODY, approveHeadSha: MR_3931_TARGET.headSha });

    assert.equal(run.calls.length, 4, verdict);
    const notTried = "Not tried, since your drafts were not published.";
    assert.deepEqual(
      outcome,
      {
        published: false,
        steps: [
          { id: "publish", label: "Publish your drafts", status: "failed", message: "glab failed: 403 Forbidden (HTTP 403)" },
          { id: "note", label: "Post the review body", status: "skipped", message: notTried },
          ...(verdict === "approve"
            ? [
                { id: "approve", label: "Approve", status: "skipped", message: notTried },
                { id: "reviewer-state", label: "Confirm your reviewer state", status: "skipped", message: notTried },
              ]
            : [{ id: "request-changes", label: "Request changes", status: "skipped", message: notTried }]),
        ],
      },
      verdict,
    );
  }
});

test("a body that could not be posted leaves the review unpublished, and the approval is tried all the same", async () => {
  const { forge, run } = forgeReplaying([
    LOGGED_IN,
    version("18.4.0"),
    { stdout: fixture("project.json") },
    {},
    { exitCode: 1, stderr: "glab: 500 Internal Server Error (HTTP 500)\n" },
    { stdout: JSON.stringify({ approved: true }) },
    { stdout: fixture("user.json") },
    reviewers("approved"),
  ]);

  const outcome = await forge.submitReview(MR_3931_TARGET, { verdict: "approve", body: BODY, approveHeadSha: MR_3931_TARGET.headSha });

  assert.match(String(run.calls.at(-3)?.args.at(-1)), /\/approve$/);
  assert.equal(outcome.published, false, "the body is kept for another try");
  assert.deepEqual(
    outcome.steps.map((step) => [step.id, step.status]),
    [
      ["publish", "done"],
      ["note", "failed"],
      ["approve", "done"],
      ["reviewer-state", "done"],
    ],
  );
});

test("an approval names the head the submit checked, the forge's own when it moved past the guide's, and none when it could not be checked", async () => {
  for (const approveHeadSha of ["f".repeat(40), null]) {
    const { forge, run } = forgeReplaying([
      LOGGED_IN,
      { stdout: fixture("project.json") },
      {},
      { stdout: JSON.stringify({ approved: true }) },
      { stdout: fixture("user.json") },
      reviewers("approved"),
    ]);

    await forge.submitReview(MR_3931_TARGET, { verdict: "approve", body: "", approveHeadSha });

    const approve = sent(run).find((call) => call.includes(`${MERGE_REQUEST}/approve`));
    assert.deepEqual(approve?.at(-1), approveHeadSha === null ? {} : { sha: approveHeadSha }, String(approveHeadSha));
  }
});

test("an approval GitLab refuses because the MR moved on during the submit says to look again", async () => {
  const { forge } = forgeReplaying([
    LOGGED_IN,
    { stdout: fixture("project.json") },
    {},
    { exitCode: 1, stderr: "glab: SHA does not match HEAD of source branch: 1a2b3c (HTTP 409)\n" },
    { stdout: fixture("user.json") },
    reviewers("reviewed"),
  ]);

  const outcome = await forge.submitReview(MR_3931_TARGET, { verdict: "approve", body: "", approveHeadSha: MR_3931_TARGET.headSha });

  assert.deepEqual(outcome.steps.at(-1), done("reviewer-state", "Confirm your reviewer state"));
  assert.deepEqual(outcome.steps.at(-2), {
    id: "approve",
    label: "Approve",
    status: "failed",
    message: "GitLab did not approve, as the MR got new commits while your review was being submitted. Open Finish review again to see them and approve.",
  });
});

test("discarding deletes every one of the viewer's draft notes, the MR-level ones too", async () => {
  const { forge, run } = forgeReplaying([
    LOGGED_IN,
    { stdout: fixture("project.json") },
    { stdout: fixture("draft-notes.ndjson") },
    {},
    {},
    {},
    {},
    {},
    {},
  ]);

  await forge.discardReview(MR_3931);

  assert.deepEqual(sent(run).slice(1), [
    ["api", "--hostname", "gitlab.com", `${DRAFT_NOTES}?per_page=100`, "--paginate", "--output", "ndjson"],
    ...["101", "102", "103", "104", "105", "106"].map((id) => ["api", "--hostname", "gitlab.com", "--method", "DELETE", `${DRAFT_NOTES}/${id}`]),
  ]);
});

test("discarding with nothing drafted deletes nothing, and a delete that fails is named once the rest were tried", async () => {
  const empty = forgeReplaying([LOGGED_IN, { stdout: fixture("project.json") }, { stdout: "" }]);
  await empty.forge.discardReview(MR_3931);
  assert.equal(empty.run.calls.length, 3);

  const { forge, run } = forgeReplaying([
    LOGGED_IN,
    { stdout: fixture("project.json") },
    { stdout: draftNotesFixture(3) },
    {},
    { exitCode: 1, stderr: "glab: 404 Not found (HTTP 404)\n" },
    {},
  ]);
  await assert.rejects(forge.discardReview(MR_3931), {
    name: "ForgeError",
    message:
      "One of your draft notes could not be deleted: 102 (glab failed: 404 Not found (HTTP 404)). Delete what is left on the merge request's page.",
  });
  assert.equal(run.calls.length, 6, "the third was deleted too");
});

/**
 * `auth-status-all*.stderr` are glab 1.120's own reports, the second for a host with a made-up token
 * that does not resolve. `review-list.json` is built by hand in the shape gitlab.com 19.5 answers,
 * since the MRs a real account reviews are not public.
 */
const AUTH_STATUS_ALL: ScriptedResult = { stderr: fixture("auth-status-all.stderr") };
const LIST_REVIEWS: readonly ScriptedResult[] = [AUTH_STATUS_ALL, version("19.5.0-pre"), { stdout: fixture("review-list.json") }];

test("reads every host glab reports, logged in or not, and why glab cannot use one", () => {
  assert.deepEqual(parseAuthStatus(fixture("auth-status-all.stderr") + fixture("auth-status-all-unreachable.stderr")), [
    { host: "gitlab.com", loggedIn: true, problem: null },
    {
      host: "gitlab.example.invalid",
      loggedIn: false,
      problem: 'API call failed: Get "https://gitlab.example.invalid/api/v4/user": dial tcp: lookup gitlab.example.invalid: no such host',
    },
  ]);
  assert.deepEqual(parseAuthStatus(""), []);
});

test("lists the open MRs the viewer reviews on each host glab is logged in to, after checking its version", async () => {
  const { forge, run } = forgeReplaying(LIST_REVIEWS);

  const hosts = await forge.listChangeRequests();

  assert.deepEqual(
    run.calls.map((call) => call.args),
    [
      ["auth", "status", "--all"],
      ["api", "--hostname", "gitlab.com", "version"],
      ["api", "graphql", "--hostname", "gitlab.com", "-f", `query=${REVIEW_LIST_QUERY}`],
    ],
  );
  assert.equal(hosts.length, 1);
  const [host] = hosts;
  assert.equal(host?.error, null);
  assert.deepEqual(host?.truncated, { assigned: false, authored: false });
  assert.deepEqual(host?.assigned[0], {
    forge: "gitlab",
    host: "gitlab.com",
    project: "example-group/service",
    number: 12,
    url: "https://gitlab.com/example-group/service/-/merge_requests/12",
    title: "Add rate limiting to the upload endpoint",
    author: "author",
    isDraft: false,
    createdAt: "2026-09-28T09:00:00Z",
    updatedAt: "2026-10-04T16:20:00Z",
    headSha: "1".repeat(40),
    additions: 120,
    deletions: 30,
    fileCount: 5,
    ci: "failure",
    state: "requested",
    viaTeam: null,
    changedSinceReview: null,
    pendingDrafts: null,
  });
});

test("an MR reads by the viewer's own reviewer record, changed when the head commit is newer than it", async () => {
  const { forge } = forgeReplaying(LIST_REVIEWS);

  const [host] = await forge.listChangeRequests();
  const summary = host?.assigned.map(({ number, state, changedSinceReview, ci, author, isDraft }) => ({ number, state, changedSinceReview, ci, author, isDraft }));

  assert.deepEqual(summary, [
    { number: 12, state: "requested", changedSinceReview: null, ci: "failure", author: "author", isDraft: false },
    { number: 40, state: "approved", changedSinceReview: false, ci: "success", author: "author", isDraft: false },
    { number: 41, state: "unapproved", changedSinceReview: true, ci: "pending", author: "author", isDraft: false },
    { number: 7, state: "changes-requested", changedSinceReview: true, ci: null, author: "ghost", isDraft: true },
    { number: 8, state: "commented", changedSinceReview: null, ci: null, author: "author", isDraft: false },
  ]);
});

test("lists the viewer's own open MRs, drafts included, with where their reviewers stand, in the same query as the MRs they review", async () => {
  const { forge, run } = forgeReplaying(LIST_REVIEWS);

  const [host] = await forge.listChangeRequests();

  assert.equal(run.calls.filter((call) => call.args[1] === "graphql").length, 1);
  assert.match(REVIEW_LIST_QUERY, /authoredMergeRequests\(state: opened, first: 100, sort: UPDATED_DESC\)/);
  assert.deepEqual(host?.authored, [
    {
      forge: "gitlab",
      host: "gitlab.com",
      project: "example-group/service",
      number: 15,
      url: "https://gitlab.com/example-group/service/-/merge_requests/15",
      title: "Stream large uploads to storage",
      author: "reviewer",
      isDraft: false,
      createdAt: "2026-10-01T08:00:00Z",
      updatedAt: "2026-10-05T09:30:00Z",
      headSha: "6".repeat(40),
      additions: 210,
      deletions: 44,
      fileCount: 7,
      ci: "success",
      pendingDrafts: null,
      status: "changes-requested",
      reviewers: [
        { name: "maintainer", state: "approved" },
        { name: "designer", state: "changes-requested" },
        { name: "backend-lead", state: "requested" },
        { name: "passer-by", state: "approved" },
      ],
      reviewedSinceLastPush: true,
      latestReviewAt: "2026-10-05T10:15:00Z",
    },
    {
      forge: "gitlab",
      host: "gitlab.com",
      project: "example-group/sub/web",
      number: 43,
      url: "https://gitlab.com/example-group/sub/web/-/merge_requests/43",
      title: "Draft: Resume an interrupted upload",
      author: "reviewer",
      isDraft: true,
      createdAt: "2026-10-02T08:00:00Z",
      updatedAt: "2026-10-02T08:10:00Z",
      headSha: "7".repeat(40),
      additions: 0,
      deletions: 0,
      fileCount: 0,
      ci: null,
      pendingDrafts: null,
      status: "unreviewed",
      reviewers: [],
      reviewedSinceLastPush: false,
      latestReviewAt: null,
    },
  ]);
});

type Interaction = { reviewState: string; approved: boolean; updatedAt: string };

/** The authored MR !15 as GitLab lists it, with these reviewer records and approvers in place of the fixture's. */
async function authored15(mr: { reviewers?: Record<string, Interaction>; approvedBy?: string[]; pushedAt?: string | null }) {
  const answer = JSON.parse(fixture("review-list.json"));
  const node = answer.data.currentUser.authoredMergeRequests.nodes[0];
  node.reviewers.nodes = Object.entries(mr.reviewers ?? {}).map(([username, mergeRequestInteraction]) => ({ username, mergeRequestInteraction }));
  node.approvedBy.nodes = (mr.approvedBy ?? []).map((username) => ({ username }));
  if (mr.pushedAt !== undefined) node.mergeRequestDiffs.nodes = mr.pushedAt === null ? [] : [{ createdAt: mr.pushedAt }];
  const { forge } = forgeReplaying([AUTH_STATUS_ALL, version("19.5.0-pre"), { stdout: JSON.stringify(answer) }]);
  return (await forge.listChangeRequests())[0]!.authored[0]!;
}

/** The fixture's head commit of !15 is dated 2026-10-05T09:00 and was pushed at 09:20. */
const BEFORE_HEAD = "2026-10-04T12:00:00Z";
const BEFORE_PUSH = "2026-10-05T09:10:00Z";
const AFTER_HEAD = "2026-10-05T11:00:00Z";
const interaction = (reviewState: string, updatedAt: string): Interaction => ({ reviewState, approved: reviewState === "APPROVED", updatedAt });

test("an approval GitLab took back reads as an approval reset, and one still standing beats it", async () => {
  const reset = await authored15({ reviewers: { maintainer: interaction("UNAPPROVED", AFTER_HEAD) } });
  const standing = await authored15({ reviewers: { maintainer: interaction("UNAPPROVED", AFTER_HEAD), lead: interaction("APPROVED", AFTER_HEAD) }, approvedBy: ["lead"] });

  assert.equal(reset.status, "approval-reset");
  assert.deepEqual(reset.reviewers, [{ name: "maintainer", state: "unapproved" }]);
  assert.equal(reset.reviewedSinceLastPush, false, "a reset is no review");
  assert.equal(reset.latestReviewAt, null);
  assert.equal(standing.status, "approved");
});

test("reviewers asked and none answered is waiting, and a review without a verdict is commented", async () => {
  const waiting = await authored15({ reviewers: { maintainer: interaction("UNREVIEWED", AFTER_HEAD), designer: interaction("REVIEW_STARTED", AFTER_HEAD) } });
  const commented = await authored15({ reviewers: { maintainer: interaction("UNREVIEWED", AFTER_HEAD), designer: interaction("REVIEWED", BEFORE_HEAD) } });

  assert.equal(waiting.status, "waiting");
  assert.equal(waiting.reviewedSinceLastPush, false);
  assert.equal(waiting.latestReviewAt, null);
  assert.equal(commented.status, "commented");
  assert.equal(commented.reviewedSinceLastPush, false, "the review is older than the head");
  assert.equal(commented.latestReviewAt, BEFORE_HEAD);
});

test("the author's own reviewer record and approval are not a review of their MR", async () => {
  const own = await authored15({ reviewers: { Reviewer: interaction("APPROVED", AFTER_HEAD) }, approvedBy: ["reviewer"] });

  assert.equal(own.status, "unreviewed");
  assert.deepEqual(own.reviewers, []);
  assert.equal(own.latestReviewAt, null);
});

test("a review between the head commit and its push is not one since the push", async () => {
  const beforePush = await authored15({ reviewers: { designer: interaction("REQUESTED_CHANGES", BEFORE_PUSH) } });

  assert.equal(beforePush.reviewedSinceLastPush, false);
});

test("whether a review came after the push is unknown when GitLab gives no version of the head", async () => {
  const undated = await authored15({ reviewers: { designer: interaction("REQUESTED_CHANGES", AFTER_HEAD) }, pushedAt: null });

  assert.equal(undated.status, "changes-requested");
  assert.equal(undated.reviewedSinceLastPush, null);
  assert.equal(undated.latestReviewAt, AFTER_HEAD);
});

test("a host glab is not logged in to, or one older than 19.2, comes back with its error and the others listed", async () => {
  const report = { exitCode: 1, stderr: fixture("auth-status-all-unreachable.stderr") + fixture("auth-status-all.stderr") };
  const { forge } = forgeReplaying([report, version("19.5.0-pre"), { stdout: fixture("review-list.json") }]);

  const hosts = await forge.listChangeRequests();

  assert.deepEqual(
    hosts.map(({ host, error, assigned, authored }) => ({ host, error, counts: [assigned.length, authored.length] })),
    [
      {
        host: "gitlab.example.invalid",
        error:
          'glab is not logged in to gitlab.example.invalid (API call failed: Get "https://gitlab.example.invalid/api/v4/user": dial tcp: lookup gitlab.example.invalid: no such host). Run `glab auth login --hostname gitlab.example.invalid` on the daemon\'s host.',
        counts: [0, 0],
      },
      { host: "gitlab.com", error: null, counts: [5, 2] },
    ],
  );

  const { forge: old } = forgeReplaying([AUTH_STATUS_ALL, version("18.11.2-ee")]);
  assert.deepEqual(await old.listChangeRequests(), [
    { forge: "gitlab", host: "gitlab.com", assigned: [], authored: [], truncated: { assigned: false, authored: false }, error: "gitlab.com runs GitLab 18.11.2-ee; listing your reviews needs 19.2 or newer." },
  ]);
});

test("a GraphQL answer with errors and no user is the host's error, and more MRs than a page mark that list truncated", async () => {
  const failed = JSON.stringify({ data: { currentUser: null }, errors: [{ message: "Query has complexity of 301, which exceeds max complexity of 250" }] });
  const { forge } = forgeReplaying([AUTH_STATUS_ALL, version("19.5.0-pre"), { stdout: failed }]);
  assert.equal(
    (await forge.listChangeRequests())[0]?.error,
    "GitLab on gitlab.com did not list your reviews: Query has complexity of 301, which exceeds max complexity of 250.",
  );

  const more = JSON.parse(fixture("review-list.json"));
  more.data.currentUser.reviewRequestedMergeRequests.pageInfo.hasNextPage = true;
  const { forge: paged } = forgeReplaying([AUTH_STATUS_ALL, version("19.5.0-pre"), { stdout: JSON.stringify(more) }]);
  assert.deepEqual((await paged.listChangeRequests())[0]?.truncated, { assigned: true, authored: false });

  const mine = JSON.parse(fixture("review-list.json"));
  mine.data.currentUser.authoredMergeRequests.pageInfo.hasNextPage = true;
  const { forge: pagedMine } = forgeReplaying([AUTH_STATUS_ALL, version("19.5.0-pre"), { stdout: JSON.stringify(mine) }]);
  assert.deepEqual((await pagedMine.listChangeRequests())[0]?.truncated, { assigned: false, authored: true });
});

test("a host listed as logged in is not checked again before reading an MR on it", async () => {
  const head = { stdout: JSON.stringify({ state: "opened", description: null, sha: "a".repeat(40), diff_refs: { head_sha: "a".repeat(40) } }) };
  const { forge, run } = forgeReplaying([...LIST_REVIEWS, { stdout: fixture("project.json") }, head]);

  await forge.listChangeRequests();
  run.calls.length = 0;

  assert.deepEqual(await forge.fetchHead(MR_3931), { headSha: "a".repeat(40), state: "open", description: "" });
  assert.ok(!run.calls.some((call) => call.args[0] === "auth"), "no auth status check");
});

const SECRET = "0bca9218f6458ccdc8d28121fbe99769";

test("an upload is named by its secret and file, in either form GitLab writes it, and only on the MR's project", () => {
  assert.deepEqual(uploadOf(MR_3931, `https://gitlab.com/gitlab-org/cli/uploads/${SECRET}/my%20shot.png`), {
    projectId: null,
    secret: SECRET,
    filename: "my shot.png",
  });
  assert.deepEqual(uploadOf(MR_3931, `https://gitlab.com/-/project/34675721/uploads/${SECRET}/shot.png`), {
    projectId: 34675721,
    secret: SECRET,
    filename: "shot.png",
  });
  for (const url of [
    `https://gitlab.com/gitlab-org/other/uploads/${SECRET}/shot.png`,
    `https://example.com/gitlab-org/cli/uploads/${SECRET}/shot.png`,
    "https://gitlab.com/gitlab-org/cli/-/raw/main/shot.png",
    "not a url",
  ]) {
    assert.equal(uploadOf(MR_3931, url), null, url);
  }
});

test("fetches an upload through the API by the project's numeric ID, once GitLab is new enough, and asks the version once", async () => {
  const { forge, run } = forgeReplaying([LOGGED_IN, { stdout: JSON.stringify({ version: "17.4.0-ee" }) }, { stdout: fixture("project.json") }, { stdout: "R0lGODlh" }, { stdout: "UklGRg==" }]);
  const url = `https://gitlab.com/gitlab-org/cli/uploads/${SECRET}/my%20shot.png`;

  assert.equal(await forge.fetchAttachment(MR_3931, url, 1024), "R0lGODlh");
  assert.equal(await forge.fetchAttachment(MR_3931, `https://gitlab.com/-/project/34675721/uploads/${SECRET}/b.png`, 1024), "UklGRg==");
  assert.equal(await forge.fetchAttachment(MR_3931, "https://img.shields.io/badge/ci.svg", 1024), null);
  assert.deepEqual(
    run.calls.slice(-2).map((call) => ({ args: call.args, stdoutEncoding: call.stdoutEncoding, maxStdoutBytes: call.maxStdoutBytes })),
    [
      { args: ["api", "--hostname", "gitlab.com", `projects/34675721/uploads/${SECRET}/my%20shot.png`], stdoutEncoding: "base64", maxStdoutBytes: 1024 },
      { args: ["api", "--hostname", "gitlab.com", `projects/34675721/uploads/${SECRET}/b.png`], stdoutEncoding: "base64", maxStdoutBytes: 1024 },
    ],
  );
  assert.equal(run.calls.filter((call) => call.args.at(-1) === "version").length, 1);
});

test("a GitLab too old to download uploads says so instead of fetching", async () => {
  const { forge, run } = forgeReplaying([LOGGED_IN, { stdout: JSON.stringify({ version: "17.3.2-ee" }) }]);

  await assert.rejects(
    forge.fetchAttachment(MR_3931, `https://gitlab.com/gitlab-org/cli/uploads/${SECRET}/shot.png`, 1024),
    new ForgeError("gitlab.com runs GitLab 17.3.2-ee; showing an uploaded image here needs 17.4 or newer."),
  );
  assert.equal(run.calls.length, 2);
});
