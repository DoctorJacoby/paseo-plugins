import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { afterEach } from "node:test";
import {
  HOST_BOUNDARY,
  boundaryResolverFromRoots,
  checkoutRoots,
  configPaths,
  loadBoundaryResolver,
  parseBoundaries,
  parseBoxProjects,
  repairsRequested,
} from "./boundary-config.ts";

// Verbatim shapes from the host's own files, comments and column padding included: the point of
// these tests is that this plugin reads what the host actually writes.
const BOUNDARIES = `# The security boundaries the credential broker serves.
#
#   <boundary>  <host>/<path pattern>  <token file>

cebud-work      gitlab.com/cebud/**                     ~/.config/gitlab-bot/token
cebud-work      gitlab.com/kobe-work/work-organisation  ~/.config/gitlab-bot/token

paseo-plugins   github.com/Someone/paseo-plugins        ~/.local/state/git/paseo-plugins.token
`;

const PROJECTS = `# The main checkouts whose every checkout runs its toolchain in a box.
#
#   <main checkout>  [<boundary>]

~/projects/remi-plus  cebud-work
~/projects/paseo-plugins  paseo-plugins
~/projects/scratch
~/projects/retired  decommissioned-zone
`;

const roots: string[] = [];

async function tempRoot(prefix: string): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), prefix));
  roots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

test("reads the boundary names out of the broker's remote-pattern lines", () => {
  assert.deepEqual(parseBoundaries(BOUNDARIES), ["cebud-work", "paseo-plugins"]);
});

test("reads each boxed checkout and the boundary its line names", () => {
  assert.deepEqual(parseBoxProjects(PROJECTS), [
    { path: "~/projects/remi-plus", boundary: "cebud-work" },
    { path: "~/projects/paseo-plugins", boundary: "paseo-plugins" },
    { path: "~/projects/scratch", boundary: null },
    { path: "~/projects/retired", boundary: "decommissioned-zone" },
  ]);
});

test("the longest matching checkout wins, and a sibling prefix is not a match", () => {
  const resolve = boundaryResolverFromRoots({
    roots: [
      { root: "/srv/code", boundary: "outer" },
      { root: "/srv/code/nested", boundary: "inner" },
    ],
    boundaries: ["outer", "inner"],
  });

  assert.equal(resolve({ cwd: "/srv/code/nested/deep" }), "inner");
  assert.equal(resolve({ cwd: "/srv/code/other" }), "outer");
  assert.equal(resolve({ cwd: "/srv/code-other" }), HOST_BOUNDARY);
});

test("a checkout in no box at all is the host itself", () => {
  const resolve = boundaryResolverFromRoots({
    roots: [{ root: "/srv/boxed", boundary: "zone" }],
    boundaries: ["zone"],
  });

  assert.equal(resolve({ cwd: "/home/me/scratch" }), HOST_BOUNDARY);
});

test("a boxed checkout with no boundary, or one the broker dropped, gets no label", () => {
  const resolve = boundaryResolverFromRoots({
    roots: [
      { root: "/srv/plain", boundary: null },
      { root: "/srv/stale", boundary: "decommissioned-zone" },
    ],
    boundaries: ["zone"],
  });

  assert.equal(resolve({ cwd: "/srv/plain/work" }), null);
  assert.equal(resolve({ cwd: "/srv/stale/work" }), null);
});

test("every worktree git recorded for a checkout counts as that checkout", async () => {
  const root = await tempRoot("workspace-management-worktrees-");
  const main = path.join(root, "main");
  const detached = path.join(root, "detached-worktree");
  await mkdir(path.join(main, ".git", "worktrees", "one"), { recursive: true });
  await writeFile(
    path.join(main, ".git", "worktrees", "one", "gitdir"),
    `${path.join(detached, ".git")}\n`,
  );

  assert.deepEqual((await checkoutRoots(main)).sort(), [detached, main].sort());
});

test("a checkout with no worktrees directory is just itself", async () => {
  const root = await tempRoot("workspace-management-bare-");

  assert.deepEqual(await checkoutRoots(root), [root]);
});

test("resolves a workspace end to end from the two host files", async () => {
  const home = await tempRoot("workspace-management-home-");
  const configRoot = await tempRoot("workspace-management-config-");
  const boundaries = path.join(configRoot, "boundaries");
  const projects = path.join(configRoot, "projects");
  await writeFile(boundaries, BOUNDARIES);
  await writeFile(projects, PROJECTS);
  const plugins = path.join(home, "projects", "paseo-plugins");
  const worktree = path.join(home, "worktrees", "plugins-issue-88");
  await mkdir(path.join(plugins, ".git", "worktrees", "issue-88"), { recursive: true });
  await writeFile(
    path.join(plugins, ".git", "worktrees", "issue-88", "gitdir"),
    `${path.join(worktree, ".git")}\n`,
  );
  await mkdir(path.join(home, "projects", "remi-plus"), { recursive: true });

  const resolve = await loadBoundaryResolver({
    HOME: home,
    WORKSPACE_MANAGEMENT_BOUNDARIES_PATH: boundaries,
    WORKSPACE_MANAGEMENT_BOX_PROJECT_CONFIG: projects,
  });

  assert.equal(resolve({ cwd: path.join(home, "projects", "remi-plus") }), "cebud-work");
  assert.equal(resolve({ cwd: plugins }), "paseo-plugins");
  assert.equal(resolve({ cwd: worktree }), "paseo-plugins");
  assert.equal(resolve({ cwd: path.join(home, "projects", "scratch") }), null);
  assert.equal(resolve({ cwd: path.join(home, "projects", "retired") }), null);
  assert.equal(resolve({ cwd: path.join(home, "notes") }), HOST_BOUNDARY);
});

test("a listed root resolves to its boundary, an unlisted one to the host", async () => {
  const home = await tempRoot("workspace-management-listed-");
  const configRoot = await tempRoot("workspace-management-listed-config-");
  const projects = path.join(configRoot, "projects");
  const boundaries = path.join(configRoot, "boundaries");
  await writeFile(boundaries, BOUNDARIES);
  await writeFile(projects, PROJECTS);
  await mkdir(path.join(home, "projects", "remi-plus"), { recursive: true });
  await mkdir(path.join(home, "projects", "elsewhere"), { recursive: true });

  const resolve = await loadBoundaryResolver({
    HOME: home,
    WORKSPACE_MANAGEMENT_BOUNDARIES_PATH: boundaries,
    WORKSPACE_MANAGEMENT_BOX_PROJECT_CONFIG: projects,
  });

  assert.equal(resolve({ cwd: path.join(home, "projects", "remi-plus") }), "cebud-work");
  assert.equal(resolve({ cwd: path.join(home, "projects", "elsewhere") }), HOST_BOUNDARY);
});

test("an empty projects map is the host saying it boxes nothing", async () => {
  const configRoot = await tempRoot("workspace-management-empty-");
  const projects = path.join(configRoot, "projects");
  const boundaries = path.join(configRoot, "boundaries");
  await writeFile(boundaries, BOUNDARIES);
  await writeFile(projects, "# nothing is boxed today\n");

  const resolve = await loadBoundaryResolver({
    HOME: configRoot,
    WORKSPACE_MANAGEMENT_BOUNDARIES_PATH: boundaries,
    WORKSPACE_MANAGEMENT_BOX_PROJECT_CONFIG: projects,
  });

  assert.equal(resolve({ cwd: "/anywhere" }), HOST_BOUNDARY);
});

test("a missing projects map labels nothing at all, and says so", async () => {
  const configRoot = await tempRoot("workspace-management-absent-");
  const missing = path.join(configRoot, "no-projects");
  const warnings: string[] = [];

  const resolve = await loadBoundaryResolver(
    {
      HOME: configRoot,
      WORKSPACE_MANAGEMENT_BOUNDARIES_PATH: path.join(configRoot, "no-boundaries"),
      WORKSPACE_MANAGEMENT_BOX_PROJECT_CONFIG: missing,
    },
    (message) => warnings.push(message),
  );

  assert.equal(resolve({ cwd: "/anywhere" }), null);
  assert.equal(resolve({ cwd: path.join(configRoot, "projects", "remi-plus") }), null);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0] ?? "", /no boxed-project map/);
  assert.match(warnings[0] ?? "", new RegExp(missing.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
});

test("a missing boundary list still knows the host, but names no boundary", async () => {
  const home = await tempRoot("workspace-management-no-boundaries-");
  const configRoot = await tempRoot("workspace-management-no-boundaries-config-");
  const projects = path.join(configRoot, "projects");
  await writeFile(projects, PROJECTS);
  await mkdir(path.join(home, "projects", "remi-plus"), { recursive: true });
  const warnings: string[] = [];

  const resolve = await loadBoundaryResolver(
    {
      HOME: home,
      WORKSPACE_MANAGEMENT_BOUNDARIES_PATH: path.join(configRoot, "no-boundaries"),
      WORKSPACE_MANAGEMENT_BOX_PROJECT_CONFIG: projects,
    },
    (message) => warnings.push(message),
  );

  assert.equal(resolve({ cwd: path.join(home, "projects", "remi-plus") }), null);
  assert.equal(resolve({ cwd: path.join(home, "notes") }), HOST_BOUNDARY);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0] ?? "", /no boundary list/);
});

test("unreadable roots are not the same answer as no roots", () => {
  assert.equal(
    boundaryResolverFromRoots({ roots: null, boundaries: ["zone"] })({ cwd: "/anywhere" }),
    null,
  );
  assert.equal(
    boundaryResolverFromRoots({ roots: [], boundaries: ["zone"] })({ cwd: "/anywhere" }),
    HOST_BOUNDARY,
  );
});

test("the host's TrustCell paths are the defaults, and the env still overrides them", () => {
  const paths = configPaths({ HOME: "/home/me" });

  assert.equal(paths.boundaries, "/home/me/dotfiles/hosts/vps/trustcell/boundaries");
  assert.equal(paths.boxProjects, "/home/me/dotfiles/hosts/vps/trustcell/projects");

  const overridden = configPaths({
    HOME: "/home/me",
    WORKSPACE_MANAGEMENT_BOUNDARIES_PATH: "/tmp/boundaries",
    WORKSPACE_MANAGEMENT_BOX_PROJECT_CONFIG: "/tmp/projects",
  });

  assert.equal(overridden.boundaries, "/tmp/boundaries");
  assert.equal(overridden.boxProjects, "/tmp/projects");
  assert.equal(
    configPaths({ HOME: "/home/me", BOX_PROJECT_CONFIG: "/tmp/legacy" }).boxProjects,
    "/tmp/legacy",
  );
});

test("a repair pass happens only when it is asked for", () => {
  assert.equal(repairsRequested({}), false);
  assert.equal(repairsRequested({ WORKSPACE_MANAGEMENT_REPAIR_LABELS: "" }), false);
  assert.equal(repairsRequested({ WORKSPACE_MANAGEMENT_REPAIR_LABELS: "0" }), false);
  assert.equal(repairsRequested({ WORKSPACE_MANAGEMENT_REPAIR_LABELS: "1" }), true);
  assert.equal(repairsRequested({ WORKSPACE_MANAGEMENT_REPAIR_LABELS: " TRUE " }), true);
});
