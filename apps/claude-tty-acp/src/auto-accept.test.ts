import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { autoAcceptDefault, readAutoAcceptDefault } from "./auto-accept.ts";

test("asks unless the host settings say otherwise", () => {
  assert.equal(autoAcceptDefault(null, "default"), false);
  assert.equal(autoAcceptDefault(null, "bypassPermissions"), false);
  assert.equal(autoAcceptDefault({ idleTimeoutMs: 0 }, "bypassPermissions"), false);
});

test("gives Bypass Permissions sessions their own setting, and the general one otherwise", () => {
  const cases: Array<[Record<string, unknown>, string, boolean]> = [
    [{ autoAccept: true }, "default", true],
    [{ autoAccept: true }, "auto", true],
    [{ autoAccept: true, bypassAutoAccept: "inherit" }, "bypassPermissions", true],
    [{ autoAccept: true, bypassAutoAccept: "off" }, "bypassPermissions", false],
    [{ autoAccept: false, bypassAutoAccept: "on" }, "bypassPermissions", true],
    // The bypass setting is about that mode alone.
    [{ autoAccept: false, bypassAutoAccept: "on" }, "acceptEdits", false],
    [{ autoAccept: true, bypassAutoAccept: "off" }, "plan", true],
  ];
  for (const [values, mode, expected] of cases) {
    assert.equal(autoAcceptDefault(values, mode), expected, `${JSON.stringify(values)} in ${mode}`);
  }
});

test("reads nothing it does not understand as an approval", () => {
  assert.equal(autoAcceptDefault({ autoAccept: "true" }, "default"), false);
  assert.equal(autoAcceptDefault({ autoAccept: 1 }, "default"), false);
  assert.equal(autoAcceptDefault({ autoAccept: false, bypassAutoAccept: true }, "bypassPermissions"), false);
  assert.equal(autoAcceptDefault({ autoAccept: true, bypassAutoAccept: "later" }, "bypassPermissions"), true);
});

test("reads the document the host saved, and asks when there is none", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "claude-tty-auto-accept-"));
  const filePath = path.join(directory, "settings.json");
  try {
    assert.equal(await readAutoAcceptDefault("bypassPermissions", null), false);
    assert.equal(await readAutoAcceptDefault("bypassPermissions", filePath), false);
    await writeFile(filePath, JSON.stringify({ version: 1, values: { idleTimeoutMs: 0, autoAccept: false, bypassAutoAccept: "on" } }));
    assert.equal(await readAutoAcceptDefault("bypassPermissions", filePath), true);
    assert.equal(await readAutoAcceptDefault("default", filePath), false);
    await writeFile(filePath, "{ not json");
    assert.equal(await readAutoAcceptDefault("bypassPermissions", filePath), false);
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
});
