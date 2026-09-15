import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

export type Env = Record<string, string | undefined>;

/** A checkout the host boxes, and the credential boundary its boxes are given. */
export interface BoxProject {
  /** The main checkout, as the host wrote it -- `~` still unexpanded. */
  path: string;
  boundary: string | null;
}

export interface BoundaryWorkspace {
  cwd: string;
  projectRootPath?: string;
}

/** What a workspace outside every boxed checkout runs in: this account, on the host itself. */
export const HOST_BOUNDARY = "host";

export type BoundaryResolver = (workspace: BoundaryWorkspace) => string | null;

/**
 * Both host files are the same line-oriented shape: `#` starts a comment, blank lines are
 * nothing, and a line is whitespace-separated fields. They are read here exactly as TrustCell
 * reads them, because a second dialect of the same file is a second thing to keep true.
 */
export function configFields(contents: string): string[][] {
  return contents
    .split("\n")
    .map((line) => line.replace(/#.*$/, "").trim())
    .filter((line) => line !== "")
    .map((line) => line.split(/\s+/));
}

/**
 * The boundaries file is one line per git remote pattern, `<boundary> <pattern> <token file>`, so
 * a boundary appears once per remote it can reach. Only the set of names is wanted here: which
 * remotes a boundary holds a token for is the broker's business, not a label's.
 */
export function parseBoundaries(contents: string): string[] {
  return [...new Set(configFields(contents).map(([boundary]) => boundary))];
}

/** The projects file is `<main checkout> [<boundary>]`; a line with no boundary declares none. */
export function parseBoxProjects(contents: string): BoxProject[] {
  return configFields(contents).map(([projectPath, boundary]) => ({
    path: projectPath,
    boundary: boundary ?? null,
  }));
}

function expandHome(value: string, home: string): string {
  if (value === "~") return home;
  if (value.startsWith("~/")) return path.join(home, value.slice(2));
  return value;
}

function contains(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

/**
 * Every checkout of one project: the main one, plus each worktree git has recorded for it. This
 * is the host's own rule -- a project line boxes the main checkout and every worktree git lists
 * for it -- read from `.git/worktrees`, which git writes on the host, rather than from any
 * working tree, which whatever runs in the box can write.
 */
export async function checkoutRoots(main: string): Promise<string[]> {
  const roots = [main];
  const worktrees = path.join(main, ".git", "worktrees");
  let names: string[];
  try {
    names = await fs.readdir(worktrees);
  } catch {
    return roots;
  }
  for (const name of names) {
    try {
      const gitdir = (await fs.readFile(path.join(worktrees, name, "gitdir"), "utf8")).trim();
      if (gitdir) roots.push(path.dirname(gitdir));
    } catch {
      // A worktree git is midway through writing, or has just been removed. Neither is this
      // plugin's business, and a missing root only costs that workspace its label.
    }
  }
  return roots;
}

export interface BoundaryRoot {
  root: string;
  boundary: string | null;
}

/**
 * Resolution is longest-root-wins, so a worktree nested under its own main checkout resolves to
 * itself. A workspace in no boxed checkout at all is running on the host, which is a trust zone
 * of its own and the loudest one. A boxed checkout whose boundary the broker does not declare
 * gets nothing: it is neither the host nor a boundary anybody still holds a token for, and
 * inventing a label for it would say something untrue.
 *
 * `roots: null` is the case where the host's map of boxed checkouts could not be read at all, and
 * it is not the same as an empty map. An empty map is the host saying it boxes nothing, so every
 * workspace really is on the host; an unreadable one says nothing, and the answer is that the
 * boundary is unknown. Reading silence as `host` is exactly how a moved config file turned into
 * every workspace wearing the loudest label there is.
 */
export function boundaryResolverFromRoots(input: {
  roots: readonly BoundaryRoot[] | null;
  boundaries: readonly string[];
}): BoundaryResolver {
  if (input.roots === null) return () => null;
  const declared = new Set(input.boundaries.map((boundary) => boundary.toLowerCase()));
  const roots = [...input.roots].sort((left, right) => right.root.length - left.root.length);

  return (workspace) => {
    const candidates = [workspace.cwd, workspace.projectRootPath]
      .filter((value): value is string => Boolean(value))
      .map((value) => path.resolve(value));
    if (candidates.length === 0) return null;
    const match = roots.find((entry) =>
      candidates.some((candidate) => contains(entry.root, candidate)),
    );
    if (!match) return HOST_BOUNDARY;
    if (!match.boundary || !declared.has(match.boundary.toLowerCase())) return null;
    return match.boundary;
  };
}

/**
 * Where TrustCell keeps the two files on this host, named once and only here.
 *
 * They have moved before: dotfiles 63b867f ("Become a consumer of TrustCell, rather than its
 * home") folded `credential-broker/` and `toolchain-box/` into `trustcell/`, and this plugin went
 * on reading the old paths, found nothing, and badged every workspace `host` for a day. Reading
 * another program's configuration behind its back is what makes that possible at all -- see the
 * README on why the reader stayed rather than shelling out to `trustcell session` -- so the least
 * this owes is one place to change when it happens again.
 */
const TRUSTCELL_CONFIG = ["dotfiles", "hosts", "vps", "trustcell"] as const;

export function configPaths(env: Env = process.env): {
  boundaries: string;
  boxProjects: string;
  home: string;
} {
  const home = env.HOME?.trim() || os.homedir();
  return {
    home,
    boundaries:
      env.WORKSPACE_MANAGEMENT_BOUNDARIES_PATH?.trim() ||
      path.join(home, ...TRUSTCELL_CONFIG, "boundaries"),
    boxProjects:
      env.WORKSPACE_MANAGEMENT_BOX_PROJECT_CONFIG?.trim() ||
      env.BOX_PROJECT_CONFIG?.trim() ||
      path.join(home, ...TRUSTCELL_CONFIG, "projects"),
  };
}

/** `null` for a file that is not there, which is a different answer from a file that is empty. */
async function readConfig(target: string): Promise<string | null> {
  try {
    return await fs.readFile(target, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new Error(`Could not read host config ${target}`, { cause: error });
  }
}

export type Warn = (message: string) => void;

function reportToConsole(message: string): void {
  console.warn(message);
}

/**
 * Read afresh on every reconciliation. The host's maps change without this plugin hearing about
 * it -- a project gets boxed, a worktree is added -- and they are two small files.
 *
 * A file that is missing fails closed and says so. The projects file is the one that decides
 * boxed from unboxed, so without it nothing can be labelled at all; without the boundaries file
 * alone the boxed checkouts are still known, they just have no name anybody still holds a token
 * for, which is the existing "no label rather than an invented one" case.
 */
export async function loadBoundaryResolver(
  env: Env = process.env,
  warn: Warn = reportToConsole,
): Promise<BoundaryResolver> {
  const paths = configPaths(env);
  const [boundaryFile, projectFile] = await Promise.all([
    readConfig(paths.boundaries),
    readConfig(paths.boxProjects),
  ]);
  if (projectFile === null) {
    warn(
      `workspace-management: no boxed-project map at ${paths.boxProjects}, so which trust boundary a workspace runs in is unknown and none is labelled. It is not that every workspace is on the host; it is that this plugin cannot tell, and saying "${HOST_BOUNDARY}" on the strength of a file that is not there is the loudest way to be wrong.`,
    );
    return boundaryResolverFromRoots({ roots: null, boundaries: [] });
  }
  if (boundaryFile === null) {
    warn(
      `workspace-management: no boundary list at ${paths.boundaries}, so no boundary counts as declared and every boxed checkout goes unlabelled. Workspaces outside every boxed checkout are still on the host.`,
    );
  }
  const projects = parseBoxProjects(projectFile);
  const roots = await Promise.all(
    projects.map(async (project) => {
      const main = path.resolve(expandHome(project.path, paths.home));
      const checkouts = await checkoutRoots(main);
      return checkouts.map((root) => ({ root, boundary: project.boundary }));
    }),
  );
  return boundaryResolverFromRoots({
    roots: roots.flat(),
    boundaries: parseBoundaries(boundaryFile ?? ""),
  });
}

/**
 * Whether this run may correct a label it can prove wrong. Off unless asked for, because removing
 * a label is not something to start doing on an upgrade; see `BoundaryLabelManager`.
 */
export function repairsRequested(env: Env = process.env): boolean {
  const value = env.WORKSPACE_MANAGEMENT_REPAIR_LABELS?.trim().toLowerCase();
  return value === "1" || value === "true" || value === "yes";
}
