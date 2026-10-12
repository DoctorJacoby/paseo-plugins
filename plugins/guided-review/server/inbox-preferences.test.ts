import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { DEFAULT_INBOX_PREFERENCES, type InboxPreferences } from "../shared/inbox-preferences.ts";
import { InboxPreferencesFile } from "./inbox-preferences.ts";

async function dataDirectory(t: TestContext): Promise<string> {
  const data = await mkdtemp(path.join(os.tmpdir(), "guided-review-inbox-preferences-"));
  t.after(() => rm(data, { recursive: true, force: true }));
  return data;
}

test("with nothing saved each tab hides what is approved and sorts by the latest update", async (t) => {
  const preferences = await new InboxPreferencesFile(await dataDirectory(t)).read();

  assert.deepEqual(preferences, {
    assigned: {
      provider: "all",
      states: ["requested", "commented", "changes-requested", "unapproved"],
      hideDrafts: false,
      checkedOff: "hide",
      needsAttention: false,
      sort: { key: "updated", descending: true },
      columns: ["checked", "change", "title", "author", "updated", "state", "local"],
    },
    authored: {
      provider: "all",
      states: ["unreviewed", "waiting", "commented", "changes-requested", "approval-reset"],
      hideDrafts: false,
      checkedOff: "hide",
      needsAttention: false,
      sort: { key: "updated", descending: true },
      columns: ["checked", "change", "title", "reviewers", "updated", "ci", "state", "local"],
    },
  });
});

test("what is saved for each tab is read back after a restart", async (t) => {
  const data = await dataDirectory(t);
  const saved: InboxPreferences = {
    assigned: {
      provider: "gitlab",
      states: ["approved", "requested"],
      hideDrafts: true,
      checkedOff: "only",
      needsAttention: true,
      sort: { key: "size", descending: false },
      columns: ["title", "ci", "size"],
    },
    authored: {
      provider: "github",
      states: ["approved", "waiting"],
      hideDrafts: true,
      checkedOff: "show",
      needsAttention: true,
      sort: { key: "created", descending: false },
      columns: ["reviewers", "title"],
    },
  };

  await new InboxPreferencesFile(data).save(saved);

  assert.deepEqual(await new InboxPreferencesFile(data).read(), {
    assigned: { ...saved.assigned, states: ["requested", "approved"], columns: ["title", "size", "ci"] },
    authored: { ...saved.authored, states: ["waiting", "approved"], columns: ["title", "reviewers"] },
  });
});

test("saving a change to one tab keeps the other tab's preferences", async (t) => {
  const data = await dataDirectory(t);
  const file = new InboxPreferencesFile(data);
  await file.save({ ...DEFAULT_INBOX_PREFERENCES, authored: { ...DEFAULT_INBOX_PREFERENCES.authored, hideDrafts: true } });

  const read = await file.read();
  await file.save({ ...read, assigned: { ...read.assigned, provider: "github" } });

  const after = await new InboxPreferencesFile(data).read();
  assert.equal(after.assigned.provider, "github");
  assert.deepEqual(after.authored, { ...DEFAULT_INBOX_PREFERENCES.authored, hideDrafts: true });
});

test("the title is always among a tab's columns", async (t) => {
  const file = new InboxPreferencesFile(await dataDirectory(t));

  const saved = await file.save({
    assigned: { ...DEFAULT_INBOX_PREFERENCES.assigned, columns: ["author"] },
    authored: { ...DEFAULT_INBOX_PREFERENCES.authored, columns: ["reviewers"] },
  });

  assert.deepEqual([saved.assigned.columns, saved.authored.columns], [["title", "author"], ["title", "reviewers"]]);
});

test("a file from before the tabs reads as the Assigned tab's, with the Authored tab at its defaults", async (t) => {
  const data = await dataDirectory(t);
  await writeFile(
    path.join(data, "inbox-preferences.json"),
    JSON.stringify({ provider: "gitlab", states: ["approved"], hideDrafts: true, checkedOff: "only", needsAttention: true, sort: { key: "size", descending: false }, columns: ["title", "ci"] }),
  );

  assert.deepEqual(await new InboxPreferencesFile(data).read(), {
    assigned: {
      provider: "gitlab",
      states: ["approved"],
      hideDrafts: true,
      checkedOff: "only",
      needsAttention: true,
      sort: { key: "size", descending: false },
      columns: ["title", "ci"],
    },
    authored: DEFAULT_INBOX_PREFERENCES.authored,
  });
});

test("a field the plugin no longer knows falls back on its own, per tab, keeping the rest of the file", async (t) => {
  const data = await dataDirectory(t);
  await writeFile(
    path.join(data, "inbox-preferences.json"),
    JSON.stringify({
      assigned: { provider: "bitbucket", hideApproved: false, states: ["merged", "approved"], hideDrafts: true, checkedOff: "archived", sort: { key: "stars" }, columns: ["title", "reactions"], extra: 1 },
      authored: { provider: "gitlab", states: ["requested", "waiting"], checkedOff: "only", columns: ["author", "reviewers"] },
    }),
  );

  assert.deepEqual(await new InboxPreferencesFile(data).read(), {
    assigned: { ...DEFAULT_INBOX_PREFERENCES.assigned, states: ["approved"], hideDrafts: true, columns: ["title"] },
    authored: { ...DEFAULT_INBOX_PREFERENCES.authored, provider: "gitlab", states: ["waiting"], checkedOff: "only", columns: ["title", "reviewers"] },
  });
});

test("a tab the file has no preferences for reads at its defaults", async (t) => {
  const data = await dataDirectory(t);
  await writeFile(path.join(data, "inbox-preferences.json"), JSON.stringify({ assigned: { hideDrafts: true }, authored: "everything" }));

  assert.deepEqual(await new InboxPreferencesFile(data).read(), {
    assigned: { ...DEFAULT_INBOX_PREFERENCES.assigned, hideDrafts: true },
    authored: DEFAULT_INBOX_PREFERENCES.authored,
  });
});

test("a list of states that would show nothing falls back to the tab's default", async (t) => {
  const data = await dataDirectory(t);
  await writeFile(path.join(data, "inbox-preferences.json"), JSON.stringify({ assigned: { states: ["merged"] }, authored: { states: ["requested"] } }));

  const read = await new InboxPreferencesFile(data).read();

  assert.deepEqual([read.assigned.states, read.authored.states], [DEFAULT_INBOX_PREFERENCES.assigned.states, DEFAULT_INBOX_PREFERENCES.authored.states]);
});

test("saves sent together all land, the last one kept", async (t) => {
  const data = await dataDirectory(t);
  const file = new InboxPreferencesFile(data);

  await Promise.all([true, false, true].map((hideDrafts) => file.save({ ...DEFAULT_INBOX_PREFERENCES, authored: { ...DEFAULT_INBOX_PREFERENCES.authored, hideDrafts } })));

  assert.equal((await file.read()).authored.hideDrafts, true);
});
