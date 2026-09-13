import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  boundaryResolverFromConfig,
  loadBoundaryResolver,
  parseBoundaryMap,
  parseBoxProjects,
} from "./boundary-config.ts";

test("resolves a workspace through the box project and the host boundary map", () => {
  const boundaries = parseBoundaryMap({
    boundaries: {
      "cebud-work": { projects: ["remi-plus"] },
      "paseo-plugins": { projects: ["paseo-plugins"] },
    },
  });
  const projects = parseBoxProjects({
    projects: [
      { name: "remi-plus", path: "~/projects/remi-plus" },
      { name: "paseo-plugins", path: "~/projects/paseo-plugins" },
    ],
  });
  const resolve = boundaryResolverFromConfig({ boundaries, projects, home: "/home/me" });

  assert.equal(resolve({ cwd: "/home/me/projects/remi-plus" }), "cebud-work");
  assert.equal(
    resolve({ cwd: "/home/me/projects/paseo-plugins/.paseo/worktrees/issue-88" }),
    "paseo-plugins",
  );
});

test("uses the most specific checkout root without matching a sibling path prefix", () => {
  const resolve = boundaryResolverFromConfig({
    boundaries: parseBoundaryMap({
      "parent-zone": ["parent"],
      "nested-zone": ["nested"],
    }),
    projects: parseBoxProjects([
      { name: "parent", path: "/srv/code" },
      { name: "nested", path: "/srv/code/nested" },
    ]),
    home: "/home/me",
  });

  assert.equal(resolve({ cwd: "/srv/code/nested/worktree" }), "nested-zone");
  assert.equal(resolve({ cwd: "/srv/code-other" }), null);
});

test("accepts an inline boundary only when the host map declares it", () => {
  const boundaries = parseBoundaryMap({
    boundaries: [{ name: "known-zone", projects: [] }],
  });
  const projects = parseBoxProjects([
    { name: "known", path: "/work/known", boundary: "known-zone" },
    { name: "stale", path: "/work/stale", boundary: "removed-zone" },
  ]);
  const resolve = boundaryResolverFromConfig({ boundaries, projects, home: "/home/me" });

  assert.equal(resolve({ cwd: "/work/known" }), "known-zone");
  assert.equal(resolve({ cwd: "/work/stale" }), null);
  assert.equal(resolve({ cwd: "/work/unconfigured" }), null);
});

test("joins a project-to-boundary host map to keyed box-project config", () => {
  const resolve = boundaryResolverFromConfig({
    boundaries: parseBoundaryMap({
      projects: {
        "sleeyax/paseo-plugins": "paseo-plugins",
      },
    }),
    projects: parseBoxProjects({
      "paseo-plugins": {
        path: "/home/me/projects/paseo-plugins",
        repository: "sleeyax/paseo-plugins",
      },
    }),
    home: "/home/me",
  });

  assert.equal(resolve({ cwd: "/home/me/projects/paseo-plugins" }), "paseo-plugins");
});

test("loads the broker map and box-project config directly from their files", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "workspace-management-"));
  const boundaries = path.join(directory, "boundaries");
  const projects = path.join(directory, "projects");
  try {
    await writeFile(
      boundaries,
      JSON.stringify({ boundaries: { "paseo-plugins": { projects: ["paseo-plugins"] } } }),
    );
    await writeFile(
      projects,
      JSON.stringify({ projects: [{ name: "paseo-plugins", path: "/projects/paseo-plugins" }] }),
    );

    const resolve = await loadBoundaryResolver({
      HOME: "/home/me",
      WORKSPACE_MANAGEMENT_BOUNDARIES_PATH: boundaries,
      WORKSPACE_MANAGEMENT_BOX_PROJECT_CONFIG: projects,
    });

    assert.equal(resolve({ cwd: "/projects/paseo-plugins/worktree" }), "paseo-plugins");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
