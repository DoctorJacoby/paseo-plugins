import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { forgeFromRemote, linkIssueReferences, readIssueForge } from "./issue-links.ts";

const github = { origin: "https://github.com", gitlab: false };
const gitlab = { origin: "https://gitlab.example.com", gitlab: true };

test("links an owner/repo reference in prose, bold or not", () => {
  assert.equal(
    linkIssueReferences("Fixed in **getpaseo/paseo#123**, see also sleeyax/paseo-plugins#7.", github),
    "Fixed in **[getpaseo/paseo#123](https://github.com/getpaseo/paseo/issues/123)**, see also [sleeyax/paseo-plugins#7](https://github.com/sleeyax/paseo-plugins/issues/7).",
  );
});

test("leaves a bare #123 alone, as Claude Code's own terminal does", () => {
  assert.equal(linkIssueReferences("Closes **#123**.", github), "Closes **#123**.");
});

test("leaves references inside code, links and URLs as written", () => {
  const markdown = [
    "Run `gh issue view owner/repo#1`.",
    "```",
    "owner/repo#2",
    "```",
    "[owner/repo#3](https://example.com/x)",
    "https://github.com/owner/repo#4 and <https://example.com/owner/repo#5>",
    "example.com/owner/repo#6 and user@owner/repo#7 and owner/repo#8a",
  ].join("\n");
  assert.equal(linkIssueReferences(markdown, github), markdown);
});

test("links a GitLab reference under nested groups to its issue page", () => {
  assert.equal(
    linkIssueReferences("See group/sub/project#42.", gitlab),
    "See [group/sub/project#42](https://gitlab.example.com/group/sub/project/-/issues/42).",
  );
});

test("reads the forge from the remote's web host", () => {
  assert.deepEqual(forgeFromRemote("git@github.com:sleeyax/paseo-plugins.git"), github);
  assert.deepEqual(forgeFromRemote("https://github.com/sleeyax/paseo-plugins"), github);
  assert.deepEqual(forgeFromRemote("ssh://git@gitlab.example.com:2222/group/project.git"), gitlab);
  assert.deepEqual(forgeFromRemote("https://gitlab.example.com:8443/group/project.git"), { origin: "https://gitlab.example.com:8443", gitlab: true });
  assert.deepEqual(forgeFromRemote("/srv/git/project.git"), github);
});

test("falls back to GitHub outside a repository", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "issue-links-test-"));
  assert.deepEqual(await readIssueForge(directory), github);
});
