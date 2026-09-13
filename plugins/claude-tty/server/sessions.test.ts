import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { sessionsDirectory, workspacesDirectory } from "./paths.ts";
import { findSessionEntry, readState } from "./sessions.ts";

/**
 * These read the state root through the environment the way the daemon does, so each test points
 * `CLAUDE_TTY_ACP_STATE_DIR` at a root of its own and restores whatever was there before.
 */
async function withStateRoot<T>(work: (root: string) => Promise<T>): Promise<T> {
  const root = await mkdtemp(path.join(os.tmpdir(), "claude-tty-sessions-test-"));
  const previous = process.env.CLAUDE_TTY_ACP_STATE_DIR;
  process.env.CLAUDE_TTY_ACP_STATE_DIR = root;
  try {
    return await work(root);
  } finally {
    if (previous === undefined) delete process.env.CLAUDE_TTY_ACP_STATE_DIR;
    else process.env.CLAUDE_TTY_ACP_STATE_DIR = previous;
    await rm(root, { force: true, recursive: true });
  }
}

async function writeSession(stateDirectory: string, id: string): Promise<void> {
  await mkdir(sessionsDirectory(stateDirectory), { recursive: true });
  await writeFile(
    path.join(sessionsDirectory(stateDirectory), `${id}.json`),
    JSON.stringify({
      version: 1,
      acpSessionId: id,
      claudeSessionId: `claude-${id}`,
      cwd: "/srv/project",
      model: "opus",
      mode: "default",
      lastActivity: 5,
    }),
  );
}

test("lists sessions from the root and from every workspace slice", async () => {
  await withStateRoot(async (root) => {
    const slice = path.join(workspacesDirectory(root), "-srv-project");
    await writeSession(root, "in-root");
    await writeSession(slice, "in-slice");
    // A stray file under workspaces/ is not a slice and must not become a phantom directory read.
    await writeFile(path.join(workspacesDirectory(root), "notes.txt"), "");

    const reading = await readState();
    assert.equal(reading.stateDirectory, root);
    assert.equal(reading.problem, null);
    assert.deepEqual(
      reading.sessions.map((entry) => [entry.id, entry.stateDirectory]).sort(),
      [
        ["in-root", root],
        ["in-slice", slice],
      ],
    );
  });
});

test("finds a single session wherever the adapter keeps it", async () => {
  await withStateRoot(async (root) => {
    const slice = path.join(workspacesDirectory(root), "-srv-project");
    await writeSession(slice, "in-slice");
    const entry = await findSessionEntry("in-slice");
    assert.equal(entry?.stateDirectory, slice);
    assert.equal(await findSessionEntry("elsewhere"), null);
  });
});

test("reads a root with no workspace slices the way it always has", async () => {
  await withStateRoot(async (root) => {
    await writeSession(root, "only");
    const reading = await readState();
    assert.deepEqual(
      reading.sessions.map((entry) => [entry.id, entry.stateDirectory]),
      [["only", root]],
    );
  });
});
