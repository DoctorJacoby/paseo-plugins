import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

export type Env = Record<string, string | undefined>;

export interface ParsedBoundaryMap {
  selectors: Readonly<Record<string, readonly string[]>>;
}

export interface BoxProject {
  name: string;
  path: string;
  boundary: string | null;
  aliases: readonly string[];
}

export interface BoundaryWorkspace {
  cwd: string;
  projectId?: string;
  projectRootPath?: string;
}

type JsonObject = Record<string, unknown>;

function object(value: unknown): JsonObject | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as JsonObject)
    : null;
}

function nonempty(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

function strings(value: unknown): string[] {
  if (typeof value === "string") return value.trim() === "" ? [] : [value.trim()];
  if (Array.isArray(value)) return value.flatMap(strings);
  const record = object(value);
  if (!record) return [];
  const scalarKeys = ["name", "id", "project", "repository", "repo", "remote", "path"];
  const collectionKeys = [
    "projects",
    "repositories",
    "repos",
    "remotes",
    "targets",
    "checkouts",
    "sources",
    "github",
    "gitlab",
  ];
  return [
    ...scalarKeys.flatMap((key) => strings(record[key])),
    ...collectionKeys.flatMap((key) => strings(record[key])),
  ];
}

function addBoundary(
  selectors: Record<string, string[]>,
  boundaryInput: unknown,
  selectorInputs: readonly unknown[],
): void {
  const boundary = nonempty(boundaryInput);
  if (!boundary) return;
  const current = selectors[boundary] ?? [];
  selectors[boundary] = [...new Set([...current, ...selectorInputs.flatMap(strings)])];
}

/**
 * The broker map has existed in keyed and list-shaped forms. Keep that host-owned shape at this
 * edge; everything after it consumes the same boundary-to-project join.
 */
export function parseBoundaryMap(input: unknown): ParsedBoundaryMap {
  const selectors: Record<string, string[]> = {};
  const root = object(input);
  const boundarySection = root?.boundaries ?? (root?.projects ? {} : input);

  if (Array.isArray(boundarySection)) {
    for (const item of boundarySection) {
      const entry = object(item);
      if (!entry) continue;
      addBoundary(selectors, entry.name ?? entry.id ?? entry.boundary, [entry]);
    }
  } else {
    const entries = object(boundarySection);
    if (entries) {
      for (const [key, value] of Object.entries(entries)) {
        if (typeof value === "string") addBoundary(selectors, value, [key]);
        else addBoundary(selectors, key, [value]);
      }
    }
  }

  const projectMap = object(root?.projects);
  if (projectMap) {
    for (const [selector, boundary] of Object.entries(projectMap)) {
      addBoundary(selectors, boundary, [selector]);
    }
  }
  return { selectors };
}

function projectFromEntry(key: string | null, value: unknown): BoxProject | null {
  if (typeof value === "string" && key) {
    return { name: key, path: value, boundary: null, aliases: [key] };
  }
  const entry = object(value);
  if (!entry) return null;
  const projectPath = nonempty(
    entry.path ?? entry.root ?? entry.cwd ?? entry.directory ?? entry.checkout,
  );
  if (!projectPath) return null;
  const name = nonempty(entry.name ?? entry.project ?? entry.id) ?? key ?? projectPath;
  const aliases = new Set<string>([
    name,
    ...strings(entry.id),
    ...strings(entry.project),
    ...strings(entry.repository),
    ...strings(entry.repo),
    ...strings(entry.remote),
    ...strings(entry.remotes),
    ...strings(entry.github),
    ...strings(entry.gitlab),
  ]);
  return {
    name,
    path: projectPath,
    boundary: nonempty(entry.boundary),
    aliases: [...aliases],
  };
}

export function parseBoxProjects(input: unknown): BoxProject[] {
  const root = object(input);
  const section = root?.projects ?? input;
  if (Array.isArray(section)) {
    return section.flatMap((entry) => {
      const project = projectFromEntry(null, entry);
      return project ? [project] : [];
    });
  }
  const entries = object(section);
  if (!entries) return [];
  return Object.entries(entries).flatMap(([key, entry]) => {
    const project = projectFromEntry(key, entry);
    return project ? [project] : [];
  });
}

function expandHome(value: string, home: string): string {
  if (value === "~") return home;
  if (value.startsWith("~/")) return path.join(home, value.slice(2));
  return value;
}

function pathContains(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function key(value: string): string {
  return value.trim().toLowerCase();
}

export function boundaryResolverFromConfig(input: {
  boundaries: ParsedBoundaryMap;
  projects: readonly BoxProject[];
  home: string;
}): (workspace: BoundaryWorkspace) => string | null {
  const boundarySelectors = Object.entries(input.boundaries.selectors).map(
    ([boundary, selectors]) => ({ boundary, selectors: new Set(selectors.map(key)) }),
  );
  const knownBoundaries = new Set(boundarySelectors.map(({ boundary }) => key(boundary)));
  const projects = input.projects.map((project) => ({
    ...project,
    path: path.resolve(expandHome(project.path, input.home)),
  }));

  return (workspace) => {
    const candidates = [workspace.projectRootPath, workspace.cwd]
      .filter((value): value is string => Boolean(value))
      .map((value) => path.resolve(expandHome(value, input.home)));
    const project = projects
      .filter(
        (candidate) =>
          (workspace.projectId !== undefined &&
            candidate.aliases.some((alias) => alias === workspace.projectId)) ||
          candidates.some((candidatePath) => pathContains(candidate.path, candidatePath)),
      )
      .sort((left, right) => right.path.length - left.path.length)[0];
    if (!project) return null;
    if (project.boundary && knownBoundaries.has(key(project.boundary))) return project.boundary;
    const aliases = new Set([project.name, project.path, ...project.aliases].map(key));
    return (
      boundarySelectors.find(({ selectors }) => [...aliases].some((alias) => selectors.has(alias)))
        ?.boundary ?? null
    );
  };
}

async function readJson(target: string): Promise<unknown[]> {
  try {
    const stat = await fs.stat(target);
    if (stat.isDirectory()) {
      const names = (await fs.readdir(target)).sort();
      const values = await Promise.all(names.map((name) => readJson(path.join(target, name))));
      return values.flat();
    }
    if (!stat.isFile()) return [];
    return [JSON.parse(await fs.readFile(target, "utf8")) as unknown];
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw new Error(`Could not read boundary config ${target}`, { cause: error });
  }
}

function mergeBoundaryMaps(maps: readonly ParsedBoundaryMap[]): ParsedBoundaryMap {
  const selectors: Record<string, string[]> = {};
  for (const map of maps) {
    for (const [boundary, values] of Object.entries(map.selectors)) {
      selectors[boundary] = [...new Set([...(selectors[boundary] ?? []), ...values])];
    }
  }
  return { selectors };
}

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
      path.join(home, "dotfiles", "hosts", "vps", "credential-broker", "boundaries"),
    boxProjects:
      env.WORKSPACE_MANAGEMENT_BOX_PROJECT_CONFIG?.trim() ||
      env.BOX_PROJECT_CONFIG?.trim() ||
      path.join(home, "dotfiles", "hosts", "vps", "toolchain-box", "projects"),
  };
}

export async function loadBoundaryResolver(
  env: Env = process.env,
): Promise<(workspace: BoundaryWorkspace) => string | null> {
  const paths = configPaths(env);
  const [boundaryFiles, projectFiles] = await Promise.all([
    readJson(paths.boundaries),
    readJson(paths.boxProjects),
  ]);
  const boundaries = mergeBoundaryMaps(boundaryFiles.map(parseBoundaryMap));
  const projects = projectFiles.flatMap(parseBoxProjects);
  return boundaryResolverFromConfig({ boundaries, projects, home: paths.home });
}
