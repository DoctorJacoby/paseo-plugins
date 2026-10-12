import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { headMoved, type AuthoredChangeRequest, type AuthoredCheckOff, type ListedHost, type ReviewRequest } from "../shared/inbox.ts";
import { fakeForge, sampleChangeRequest, type FakeForge } from "./fake-forge.ts";
import { fakeGuideAgents, sampleGuideReply, type FakeGuideAgents } from "./fake-guide-agents.ts";
import { fakeWorkspaces, type FakeWorkspaces } from "./fake-workspaces.ts";
import { ForgeError } from "./forge/port.ts";
import { ReviewService } from "./review-service.ts";

const GITHUB_URL = "https://github.com/acme/uploader/pull/7";
const GITLAB_URL = "https://gitlab.com/acme/uploader/-/merge_requests/7";
const GITHUB_ID = "github/github.com/acme/uploader/7";
const GITLAB_ID = "gitlab/gitlab.com/acme/uploader/7";
const HEAD = "b".repeat(40);
const PUSHED = "d".repeat(40);

type Host = { data: string; github: FakeForge; gitlab: FakeForge; workspaces: FakeWorkspaces; guideAgents: FakeGuideAgents; service: ReviewService; restart: () => ReviewService };

async function withForges(t: TestContext): Promise<Host> {
  const data = await mkdtemp(path.join(os.tmpdir(), "guided-review-inbox-"));
  t.after(() => rm(data, { recursive: true, force: true }));
  const github = fakeForge("github");
  const gitlab = fakeForge("gitlab");
  github.changeRequests.set(GITHUB_URL, sampleChangeRequest(GITHUB_URL));
  gitlab.changeRequests.set(GITLAB_URL, sampleChangeRequest(GITLAB_URL));
  const workspaces = fakeWorkspaces();
  workspaces.repositories.set("github.com/acme/uploader", "/home/r/src/uploader");
  workspaces.repositories.set("gitlab.com/acme/uploader", "/home/r/src/uploader-gl");
  const guideAgents = fakeGuideAgents();
  guideAgents.answer = () => sampleGuideReply();
  const restart = () => new ReviewService({ forges: [github, gitlab], workspaces, guideAgents, dataDirectory: data });
  return { data, github, gitlab, workspaces, guideAgents, service: restart(), restart };
}

async function startReview(service: ReviewService, url: string) {
  await service.start({ url });
  await service.settled();
}

function request(url: string, overrides: Partial<ReviewRequest> = {}): ReviewRequest {
  const gitlab = url.includes("/-/merge_requests/");
  return {
    forge: gitlab ? "gitlab" : "github",
    host: gitlab ? "gitlab.com" : "github.com",
    project: "acme/uploader",
    number: 7,
    url,
    title: "Retry failed uploads",
    author: "author",
    isDraft: false,
    createdAt: "2026-09-01T10:00:00Z",
    updatedAt: "2026-09-02T10:00:00Z",
    headSha: HEAD,
    additions: 42,
    deletions: 7,
    fileCount: 2,
    ci: null,
    state: "requested",
    viaTeam: null,
    changedSinceReview: null,
    pendingDrafts: gitlab ? null : 0,
    ...overrides,
  };
}

function authored(url: string, overrides: Partial<AuthoredChangeRequest> = {}): AuthoredChangeRequest {
  const { state: _, viaTeam: __, changedSinceReview: ___, ...listed } = request(url, { author: "reviewer" });
  return { ...listed, status: "unreviewed", reviewers: [], reviewedSinceLastPush: false, latestReviewAt: null, ...overrides };
}

const COMPLETE = { assigned: false, authored: false };

function listed(forge: "github" | "gitlab", assigned: ReviewRequest[], extra: Partial<ListedHost> = {}): ListedHost {
  return { forge, host: forge === "github" ? "github.com" : "gitlab.com", assigned, authored: [], truncated: COMPLETE, error: null, ...extra };
}

test("lists every forge's review requests and the viewer's own change requests with their hosts, and none started here has a local review", async (t) => {
  const { github, gitlab, service } = await withForges(t);
  const mine = "https://github.com/acme/uploader/pull/9";
  github.listedHosts = [listed("github", [request(GITHUB_URL)], { authored: [authored(mine, { number: 9 })], truncated: { assigned: true, authored: false } })];
  gitlab.listedHosts = [
    listed("gitlab", [request(GITLAB_URL)], { truncated: { assigned: false, authored: true } }),
    listed("gitlab", [], { host: "gitlab.example.com", error: "glab is not logged in to gitlab.example.com." }),
  ];

  const inbox = await service.inbox();

  assert.deepEqual(inbox.hosts, [
    { forge: "github", host: "github.com", truncated: { assigned: true, authored: false }, error: null },
    { forge: "gitlab", host: "gitlab.com", truncated: { assigned: false, authored: true }, error: null },
    { forge: "gitlab", host: "gitlab.example.com", truncated: COMPLETE, error: "glab is not logged in to gitlab.example.com." },
  ]);
  assert.deepEqual(inbox.assigned, [
    { ...request(GITHUB_URL), reviewId: GITHUB_ID, local: null, checkedOff: false },
    { ...request(GITLAB_URL), reviewId: GITLAB_ID, local: null, checkedOff: false },
  ]);
  assert.deepEqual(inbox.authored, [{ ...authored(mine, { number: 9 }), reviewId: "github/github.com/acme/uploader/9", local: null, checkedOff: false }]);
});

test("a change request of the viewer's reviewed here carries its review, its guide's state, whether the head moved and its drafts", async (t) => {
  const { github, service } = await withForges(t);
  await startReview(service, GITHUB_URL);

  github.listedHosts = [listed("github", [], { authored: [authored(GITHUB_URL, { pendingDrafts: 2 })] })];
  const [item] = (await service.inbox()).authored;
  assert.equal(item?.reviewId, GITHUB_ID);
  assert.deepEqual({ ...item?.local, header: null }, { header: null, preparing: null, guide: "ready", workspaceId: "wks_0000000000000001" });
  assert.equal(headMoved(item!, item!.local!), false);
  assert.equal(item?.pendingDrafts, 2);

  github.listedHosts = [listed("github", [], { authored: [authored(GITHUB_URL, { headSha: PUSHED })] })];
  const [pushed] = (await service.inbox()).authored;
  assert.equal(headMoved(pushed!, pushed!.local!), true);
});

test("an MR the viewer authored and reviews is listed on both tabs with one review here, its guide and its drafts counted once", async (t) => {
  const { gitlab, service } = await withForges(t);
  await startReview(service, GITLAB_URL);
  gitlab.drafts.set(GITLAB_URL, [{ id: "1", body: "Why the retry cap?", location: { kind: "general" } }]);
  const listDrafts = gitlab.listDrafts.bind(gitlab);
  let counted = 0;
  gitlab.listDrafts = async (ref) => {
    counted += 1;
    return listDrafts(ref);
  };

  gitlab.listedHosts = [listed("gitlab", [request(GITLAB_URL)], { authored: [authored(GITLAB_URL)] })];
  const inbox = await service.inbox();

  assert.equal(inbox.authored[0]?.reviewId, GITLAB_ID);
  assert.equal(inbox.assigned[0]?.reviewId, GITLAB_ID);
  assert.equal(inbox.authored[0]?.local?.guide, "ready");
  assert.deepEqual(inbox.authored[0]?.local, inbox.assigned[0]?.local);
  assert.deepEqual([inbox.assigned[0]?.pendingDrafts, inbox.authored[0]?.pendingDrafts], [1, 1]);
  assert.equal(counted, 1);
});

test("a change request reviewed here carries its review, its guide's state and whether the forge's head moved past it", async (t) => {
  const { github, service } = await withForges(t);
  await startReview(service, GITHUB_URL);

  github.listedHosts = [listed("github", [request(GITHUB_URL)])];
  const [item] = (await service.inbox()).assigned;
  assert.equal(item?.local?.header?.headSha, HEAD);
  assert.deepEqual({ ...item?.local, header: null }, { header: null, preparing: null, guide: "ready", workspaceId: "wks_0000000000000001" });
  assert.equal(headMoved(item!, item!.local!), false);

  github.listedHosts = [listed("github", [request(GITHUB_URL, { headSha: PUSHED })])];
  const [pushed] = (await service.inbox()).assigned;
  assert.equal(headMoved(pushed!, pushed!.local!), true);
});

test("a start that failed before the change request was read lists as failed, with no review behind it", async (t) => {
  const { github, service } = await withForges(t);
  github.changeRequests.delete(GITHUB_URL);
  await startReview(service, GITHUB_URL);

  github.listedHosts = [listed("github", [request(GITHUB_URL)])];
  const local = (await service.inbox()).assigned[0]?.local;
  assert.equal(local?.preparing?.phase, "failed");
  assert.match(local?.preparing?.message ?? "", /^Could not read /);
  assert.deepEqual({ ...local, preparing: null }, { header: null, preparing: null, guide: "none", workspaceId: null });
});

test("a review whose workspace was archived has no workspace to open, and the list follows a review by ID as it lists it", async (t) => {
  const { github, workspaces, service } = await withForges(t);
  await startReview(service, GITHUB_URL);
  workspaces.archive("wks_0000000000000001");

  github.listedHosts = [listed("github", [request(GITHUB_URL)])];
  const listedLocal = (await service.inbox()).assigned[0]?.local;
  assert.equal(listedLocal?.workspaceId, null);
  assert.deepEqual(await service.localReviews({ reviewIds: [GITHUB_ID, GITLAB_ID] }), {
    reviews: [
      { reviewId: GITHUB_ID, local: listedLocal },
      { reviewId: GITLAB_ID, local: null },
    ],
  });
});

test("a start reads as ready only once its guide is being generated", async (t) => {
  const { guideAgents, service } = await withForges(t);
  let release: ((reply: string) => void) | undefined;
  guideAgents.answer = () => new Promise<string>((resolve) => (release = resolve));

  await service.start({ url: GITHUB_URL });
  while ((await service.startProgress({ reviewId: GITHUB_ID })).phase !== "ready") await new Promise((resolve) => setImmediate(resolve));
  const [review] = (await service.localReviews({ reviewIds: [GITHUB_ID] })).reviews;
  assert.equal(review?.local?.guide, "generating");
  assert.equal(review?.local?.preparing, null);

  while (release === undefined) await new Promise((resolve) => setImmediate(resolve));
  release(sampleGuideReply());
  await service.settled();
  assert.equal((await service.localReviews({ reviewIds: [GITHUB_ID] })).reviews[0]?.local?.guide, "ready");
});

test("on GitLab the drafts are counted for an MR reviewed here only, and a failed count reads as unknown", async (t) => {
  const { gitlab, service } = await withForges(t);
  await startReview(service, GITLAB_URL);
  const other = "https://gitlab.com/acme/uploader/-/merge_requests/8";
  gitlab.drafts.set(GITLAB_URL, [
    { id: "1", body: "Why the retry cap?", location: { kind: "general" } },
    { id: "2", body: "Typo", location: { kind: "file", path: "src/upload.ts" } },
  ]);
  gitlab.listedHosts = [listed("gitlab", [request(GITLAB_URL), request(other, { number: 8 })])];

  const items = (await service.inbox()).assigned;
  assert.deepEqual(
    items.map((item) => item.pendingDrafts),
    [2, null],
  );

  gitlab.listDrafts = async () => {
    throw new ForgeError("glab failed: 500 Internal Server Error");
  };
  assert.equal((await service.inbox()).assigned[0]?.pendingDrafts, null);
});

test("a GitLab review published from here says whether the head moved since, over the listing's guess", async (t) => {
  const { gitlab, service } = await withForges(t);
  await startReview(service, GITLAB_URL);
  const reviewId = "gitlab/gitlab.com/acme/uploader/7";

  gitlab.listedHosts = [listed("gitlab", [request(GITLAB_URL, { state: "commented", changedSinceReview: null })])];
  assert.equal((await service.inbox()).assigned[0]?.changedSinceReview, null, "nothing published from here yet");

  const submitted = await service.submit({ reviewId, headSha: HEAD, forgeHeadSha: HEAD, verdict: "comment", body: "Reads well." });
  assert.equal(submitted.status, "submitted");

  gitlab.listedHosts = [listed("gitlab", [request(GITLAB_URL, { state: "commented", changedSinceReview: true })])];
  assert.equal((await service.inbox()).assigned[0]?.changedSinceReview, false, "the head is still the one reviewed");

  gitlab.listedHosts = [listed("gitlab", [request(GITLAB_URL, { state: "commented", headSha: PUSHED, changedSinceReview: false })])];
  assert.equal((await service.inbox()).assigned[0]?.changedSinceReview, true, "pushed since");

  gitlab.listedHosts = [listed("gitlab", [request(GITLAB_URL, { state: "requested", changedSinceReview: null })])];
  assert.equal((await service.inbox()).assigned[0]?.changedSinceReview, null, "asked again, which the listing says");
});

async function checkedOff(service: ReviewService, tab: "assigned" | "authored" = "assigned"): Promise<string[]> {
  const inbox = await service.inbox();
  return inbox[tab].filter((item) => item.checkedOff).map((item) => item.url);
}

test("a check-off holds while the change request stands still, survives a restart and is undone by unchecking", async (t) => {
  const { github, gitlab, service, restart } = await withForges(t);
  github.listedHosts = [listed("github", [request(GITHUB_URL)])];
  gitlab.listedHosts = [listed("gitlab", [request(GITLAB_URL)])];

  await service.setCheckedOff({ tab: "assigned", url: GITLAB_URL, checkOff: { headSha: HEAD, state: "requested" } });
  assert.deepEqual(await checkedOff(service), [GITLAB_URL]);
  assert.deepEqual(await checkedOff(restart()), [GITLAB_URL], "still requested, as when it was checked off");

  await service.setCheckedOff({ tab: "assigned", url: GITLAB_URL, checkOff: null });
  assert.deepEqual(await checkedOff(service), []);
});

test("a check-off comes back on a push, or when the reviewer is asked again or loses an approval", async (t) => {
  const { gitlab, service } = await withForges(t);
  const comeBack = async (checkOff: { headSha: string; state: ReviewRequest["state"] }, ...listings: Partial<ReviewRequest>[]) => {
    await service.setCheckedOff({ tab: "assigned", url: GITLAB_URL, checkOff });
    const seen: boolean[] = [];
    for (const listing of listings) {
      gitlab.listedHosts = [listed("gitlab", [request(GITLAB_URL, listing)])];
      seen.push((await checkedOff(service)).length === 1);
    }
    return seen;
  };

  assert.deepEqual(await comeBack({ headSha: HEAD, state: "commented" }, { state: "commented", headSha: PUSHED }, { state: "commented", headSha: HEAD }), [false, false]);
  assert.deepEqual(await comeBack({ headSha: HEAD, state: "commented" }, { state: "requested" }), [false]);
  assert.deepEqual(await comeBack({ headSha: HEAD, state: "approved" }, { state: "unapproved" }), [false]);
  assert.deepEqual(
    await comeBack({ headSha: HEAD, state: "requested" }, { state: "commented" }, { state: "changes-requested" }, { state: "requested" }),
    [true, true, false],
    "a state the reviewer moved to themselves holds, and being asked again after it brings it back",
  );
  assert.deepEqual(await comeBack({ headSha: HEAD, state: "requested" }, { state: "requested", headSha: "" }), [true], "a head the forge did not say is no push");
});

test("a check-off goes once a host listed in full no longer has it, and stays while its host fails or has more", async (t) => {
  const { gitlab, service } = await withForges(t);
  gitlab.listedHosts = [listed("gitlab", [request(GITLAB_URL)])];
  await service.setCheckedOff({ tab: "assigned", url: GITLAB_URL, checkOff: { headSha: HEAD, state: "requested" } });

  gitlab.listedHosts = [listed("gitlab", [], { error: "glab is not logged in to gitlab.com." })];
  await service.inbox();
  gitlab.listedHosts = [listed("gitlab", [], { truncated: { assigned: true, authored: false } })];
  await service.inbox();
  gitlab.listedHosts = [listed("gitlab", [request(GITLAB_URL)])];
  assert.deepEqual(await checkedOff(service), [GITLAB_URL]);

  gitlab.listedHosts = [listed("gitlab", [])];
  await service.inbox();
  gitlab.listedHosts = [listed("gitlab", [request(GITLAB_URL)])];
  assert.deepEqual(await checkedOff(service), []);
});

test("an authored check-off goes once a host listed its authored ones in full without it, and stays while its host fails or has more", async (t) => {
  const { gitlab, service } = await withForges(t);
  const mine = (extra: Partial<ListedHost> = {}) => listed("gitlab", [], { authored: [authored(GITLAB_URL)], ...extra });
  gitlab.listedHosts = [mine()];
  await service.setCheckedOff({ tab: "authored", url: GITLAB_URL, checkOff: { status: "unreviewed", latestReviewAt: null } });

  gitlab.listedHosts = [listed("gitlab", [], { error: "glab is not logged in to gitlab.com." })];
  await service.inbox();
  gitlab.listedHosts = [listed("gitlab", [], { truncated: { assigned: false, authored: true } })];
  await service.inbox();
  gitlab.listedHosts = [mine()];
  assert.deepEqual(await checkedOff(service, "authored"), [GITLAB_URL]);

  gitlab.listedHosts = [listed("gitlab", [], { truncated: { assigned: true, authored: false } })];
  await service.inbox();
  gitlab.listedHosts = [mine()];
  assert.deepEqual(await checkedOff(service, "authored"), [], "only the Authored list having more keeps it");
});

test("a check-off kept before the list had tabs holds on the Assigned tab", async (t) => {
  const { data, gitlab, service } = await withForges(t);
  gitlab.listedHosts = [listed("gitlab", [request(GITLAB_URL)])];
  const file = path.join(data, "inbox-check-offs.json");
  await writeFile(file, JSON.stringify({ [GITLAB_URL]: { headSha: HEAD, state: "requested" } }));

  assert.deepEqual(await checkedOff(service), [GITLAB_URL]);

  await service.setCheckedOff({ tab: "assigned", url: GITHUB_URL, checkOff: { headSha: HEAD, state: "requested" } });
  assert.deepEqual(JSON.parse(await readFile(file, "utf8")), {
    assigned: { [GITLAB_URL]: { headSha: HEAD, state: "requested" }, [GITHUB_URL]: { headSha: HEAD, state: "requested" } },
    authored: {},
  });
});

test("a check-off on one tab leaves the same MR on the other tab alone, and comes back on that tab only", async (t) => {
  const { gitlab, service } = await withForges(t);
  const onBothTabs = (headSha = HEAD, mine: Partial<AuthoredChangeRequest> = {}) => {
    gitlab.listedHosts = [listed("gitlab", [request(GITLAB_URL, { headSha })], { authored: [authored(GITLAB_URL, { ...mine, headSha })] })];
  };
  const tabs = async () => {
    const inbox = await service.inbox();
    return [inbox.assigned[0]?.checkedOff, inbox.authored[0]?.checkedOff];
  };
  onBothTabs();

  await service.setCheckedOff({ tab: "authored", url: GITLAB_URL, checkOff: { status: "unreviewed", latestReviewAt: null } });
  assert.deepEqual(await tabs(), [false, true]);
  await service.setCheckedOff({ tab: "assigned", url: GITLAB_URL, checkOff: { headSha: HEAD, state: "requested" } });
  assert.deepEqual(await tabs(), [true, true]);

  onBothTabs(PUSHED);
  assert.deepEqual(await tabs(), [false, true], "a push brings it back on Assigned only");

  await service.setCheckedOff({ tab: "assigned", url: GITLAB_URL, checkOff: { headSha: PUSHED, state: "requested" } });
  onBothTabs(PUSHED, { status: "commented", latestReviewAt: "2026-09-03T10:00:00Z" });
  assert.deepEqual(await tabs(), [true, false], "a review brings it back on Authored only");
});

test("an authored check-off holds while its reviews stand still, survives a restart and is undone by unchecking", async (t) => {
  const { github, gitlab, service, restart } = await withForges(t);
  github.listedHosts = [listed("github", [], { authored: [authored(GITHUB_URL, { status: "waiting" })] })];
  gitlab.listedHosts = [listed("gitlab", [], { authored: [authored(GITLAB_URL, { status: "commented", latestReviewAt: "2026-09-03T10:00:00Z" })] })];

  await service.setCheckedOff({ tab: "authored", url: GITLAB_URL, checkOff: { status: "commented", latestReviewAt: "2026-09-03T10:00:00Z" } });
  assert.deepEqual(await checkedOff(service, "authored"), [GITLAB_URL]);
  assert.deepEqual(await checkedOff(restart(), "authored"), [GITLAB_URL], "no review since it was checked off");

  await service.setCheckedOff({ tab: "authored", url: GITLAB_URL, checkOff: null });
  assert.deepEqual(await checkedOff(service, "authored"), []);
});

test("an authored check-off comes back when its review status changes or a newer review arrives, and holds over a push", async (t) => {
  const { gitlab, service } = await withForges(t);
  const REVIEWED = "2026-09-03T10:00:00Z";
  const comeBack = async (checkOff: AuthoredCheckOff, ...listings: Partial<AuthoredChangeRequest>[]) => {
    await service.setCheckedOff({ tab: "authored", url: GITLAB_URL, checkOff });
    const seen: boolean[] = [];
    for (const listing of listings) {
      gitlab.listedHosts = [listed("gitlab", [], { authored: [authored(GITLAB_URL, listing)] })];
      seen.push((await checkedOff(service, "authored")).length === 1);
    }
    return seen;
  };
  const approved = { status: "approved", latestReviewAt: REVIEWED } as const;

  assert.deepEqual(await comeBack(approved, { ...approved, headSha: PUSHED }, { ...approved, headSha: HEAD }), [true, true], "a push alone is no news");
  assert.deepEqual(await comeBack(approved, { status: "changes-requested", latestReviewAt: "2026-09-04T10:00:00Z" }), [false]);
  assert.deepEqual(await comeBack(approved, { ...approved, latestReviewAt: "2026-09-04T10:00:00Z" }), [false], "approved again by another reviewer");
  assert.deepEqual(await comeBack({ status: "waiting", latestReviewAt: null }, { status: "commented", latestReviewAt: REVIEWED }), [false]);
  assert.deepEqual(await comeBack(approved, { status: "approval-reset", latestReviewAt: null, headSha: PUSHED }), [false], "an approval reset, which GitLab leaves with no review");
  assert.deepEqual(await comeBack(approved, { ...approved, latestReviewAt: "2026-09-02T10:00:00Z" }), [false], "a review taken back, leaving an older one newest");
});
