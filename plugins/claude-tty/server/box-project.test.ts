import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { checkBoxProject, listBoxProjects } from "./box-project.ts";

/**
 * A stand-in for the host's box-project, answering from a script the test writes and recording every
 * call. The real one is the host's own, and the shape of its JSON with it; what is tested here is
 * that this asks it, passes the arguments it means to, and turns whatever comes back — including
 * nothing — into an answer the panel can render.
 */
async function fakeBoxProject(
  directory: string,
  script: string,
): Promise<{ command: string; calls: () => Promise<string[]> }> {
  const command = path.join(directory, "box-project");
  const log = path.join(directory, "calls");
  await writeFile(command, `#!/bin/bash\necho "$@" >>${JSON.stringify(log)}\n${script}\n`, { mode: 0o700 });
  await chmod(command, 0o700);
  return {
    command,
    calls: async () => (await readFile(log, "utf8").catch(() => "")).split("\n").filter((line) => line !== ""),
  };
}

async function withTool(script: string, run: (env: Record<string, string>, calls: () => Promise<string[]>) => Promise<void>) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "box-project-"));
  try {
    const tool = await fakeBoxProject(directory, script);
    await run({ BOX_PROJECT_BIN: tool.command }, tool.calls);
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
}

const LIST = JSON.stringify([
  {
    projectId: "prj_1",
    name: "REMI+",
    path: "/home/me/projects/remi-plus",
    state: "registered",
    boundary: "cebud-work",
    reason: "",
    display: "REMI+",
  },
  {
    projectId: "prj_2",
    name: "dotfiles",
    path: "/home/me/dotfiles",
    state: "host",
    boundary: "",
    reason: "/home/me/dotfiles is a host workspace in sessions",
    display: "host:dotfiles",
  },
  {
    projectId: "prj_3",
    name: "scratch",
    path: "/tmp/scratch",
    state: "unregistered",
    boundary: "",
    reason: "/tmp/scratch is in no checkout with a session box",
    display: "scratch",
  },
]);

test("keeps the three states the host distinguishes, and the host's own display name with them", async () => {
  await withTool(`cat <<'JSON'\n${LIST}\nJSON`, async (env, calls) => {
    const payload = await listBoxProjects(env);

    assert.deepEqual(await calls(), ["ls --json"]);
    assert.equal(payload.available, true);
    assert.equal(payload.problem, null);
    assert.deepEqual(
      payload.projects.map((project) => [project.state, project.display, project.boundary]),
      [
        ["registered", "REMI+", "cebud-work"],
        ["host", "host:dotfiles", null],
        ["unregistered", "scratch", null],
      ],
    );
  });
});

test("a host with no box-project has nothing to say rather than a failure to report", async () => {
  const payload = await listBoxProjects({ BOX_PROJECT_BIN: "/nowhere/box-project" });

  assert.equal(payload.available, false);
  assert.equal(payload.problem, null);
  assert.deepEqual(payload.projects, []);
});

test("says what the tool said when it is there and will not answer", async () => {
  await withTool('echo "box-project: the broker is not running" >&2\nexit 1', async (env) => {
    const payload = await listBoxProjects(env);

    assert.equal(payload.available, true);
    assert.equal(payload.problem, "box-project: the broker is not running");
    assert.deepEqual(payload.projects, []);
  });
});

test("asks about a project by name, and reports a failing check as an answer rather than an error", async () => {
  const report = JSON.stringify({
    project: "vibemacs",
    ok: false,
    checks: [
      { id: "clone", title: "the clone at ~/projects/vibemacs", state: "ok", detail: "origin github.com/me/vibemacs" },
      { id: "token", title: "the forge token", state: "fail", detail: "missing or empty" },
      { id: "host-node", title: "node is off the host's PATH", state: "note", detail: "still on PATH: node" },
    ],
  });

  // Exit 1 is what box-project does when a project is misconfigured, which is the answer it was
  // asked for: only output that will not parse is a failure.
  await withTool(`cat <<'JSON'\n${report}\nJSON\nexit 1`, async (env, calls) => {
    const payload = await checkBoxProject("vibemacs", env);

    assert.deepEqual(await calls(), ["check vibemacs --json"]);
    assert.equal(payload.ran, true);
    assert.equal(payload.ok, false);
    assert.equal(payload.problem, null);
    assert.deepEqual(
      payload.checks.map((check) => [check.id, check.state]),
      [
        ["clone", "ok"],
        ["token", "fail"],
        ["host-node", "note"],
      ],
    );
  });
});

test("a check that printed no JSON is not a passing check", async () => {
  await withTool('echo "Traceback, sort of" >&2\nexit 2', async (env) => {
    const payload = await checkBoxProject("vibemacs", env);

    assert.equal(payload.ran, false);
    assert.equal(payload.ok, false);
    assert.equal(payload.problem, "Traceback, sort of");
    assert.deepEqual(payload.checks, []);
  });
});

test("drops a row that is not a project rather than rendering a hole", async () => {
  const mixed = JSON.stringify([{ path: "/no/id" }, { projectId: "prj_1", path: "/home/me/x", state: "nonsense" }]);

  await withTool(`cat <<'JSON'\n${mixed}\nJSON`, async (env) => {
    const payload = await listBoxProjects(env);

    assert.equal(payload.projects.length, 1);
    // An unreadable state is the safe one: it says a session there would be refused, which is what
    // every state but `registered` and `host` means anyway.
    assert.equal(payload.projects[0]?.state, "unregistered");
    assert.equal(payload.projects[0]?.name, "/home/me/x");
  });
});
