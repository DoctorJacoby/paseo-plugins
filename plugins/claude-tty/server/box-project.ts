import os from "node:os";
import path from "node:path";
import type { BoxProjectListPayload, BoxProjectReportPayload } from "../shared/contracts.ts";
import { runCommand } from "./exec.ts";
import type { Env } from "./paths.ts";

/**
 * `box-project`, this host's own onboarding tool, asked rather than reimplemented.
 *
 * Which projects are configured, and what is wrong with one, is a question about files only the host
 * owns — the broker's boundary map, the list of boxed checkouts, the session allowlist. The tool that
 * writes them is also the one that reads them, and a second copy of those rules living in a plugin
 * would be a second answer to give when they disagree. So this spawns it, parses its JSON, and adds
 * nothing of its own but the wording of a failure to spawn.
 *
 * A host with no such tool is an answer, not an error: most machines this plugin runs on have none,
 * and the panel says so once instead of every section reporting a crash.
 */

/** The panel polls this, and a project does not change its configuration between two polls. */
const LIST_TIMEOUT_MS = 20_000;

/**
 * A check asks the credential broker for a fetch and a push handshake, so it is a network round trip
 * and not a file read. The daemon kills a plugin RPC at thirty seconds, which is the ceiling this
 * has to stay under to be able to report its own timeout.
 */
const CHECK_TIMEOUT_MS = 25_000;

function binary(env: Env): string {
  return env.BOX_PROJECT_BIN?.trim() || path.join(env.HOME || os.homedir(), ".local", "bin", "box-project");
}

export async function listBoxProjects(env: Env = process.env): Promise<BoxProjectListPayload> {
  const result = await runCommand(binary(env), ["ls", "--json"], { cwd: "/", timeoutMs: LIST_TIMEOUT_MS });
  if (result.spawnError !== null && /ENOENT/.test(result.spawnError)) {
    return { available: false, problem: null, projects: [] };
  }
  const parsed = parseJson(result.stdout);
  if (result.spawnError !== null || parsed === null) {
    return { available: true, problem: failure(result, parsed === null), projects: [] };
  }
  return { available: true, problem: null, projects: normaliseProjects(parsed) };
}

/**
 * `check` exits non-zero when a project is misconfigured, which is the answer and not a failure — so
 * only output that will not parse counts as one.
 */
export async function checkBoxProject(name: string, env: Env = process.env): Promise<BoxProjectReportPayload> {
  const result = await runCommand(binary(env), ["check", name, "--json"], { cwd: "/", timeoutMs: CHECK_TIMEOUT_MS });
  const parsed = parseJson(result.stdout);
  if (parsed === null) {
    return { project: name, ran: false, ok: false, problem: failure(result, true), checks: [] };
  }
  const report = parsed as { project?: unknown; ok?: unknown; checks?: unknown };
  return {
    project: typeof report.project === "string" ? report.project : name,
    ran: true,
    ok: report.ok === true,
    problem: null,
    checks: normaliseChecks(report.checks),
  };
}

function parseJson(stdout: string): unknown {
  const text = stdout.trim();
  if (text === "") return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/**
 * What went wrong, as a sentence. stderr first: box-project says everything it has to say there, and
 * an exit code on its own tells a reader nothing they can act on.
 */
function failure(
  result: { exitCode: number | null; stderr: string; spawnError: string | null },
  unparseable: boolean,
): string {
  if (result.spawnError !== null) return result.spawnError;
  const said = result.stderr.trim();
  if (said !== "") return said;
  if (unparseable) return `box-project exited ${result.exitCode ?? "without a code"} and printed nothing to parse`;
  return `box-project exited ${result.exitCode ?? "without a code"}`;
}

const STATES = new Set(["registered", "host", "unregistered"]);
const CHECK_STATES = new Set(["ok", "fail", "note"]);

function normaliseProjects(parsed: unknown): BoxProjectListPayload["projects"] {
  if (!Array.isArray(parsed)) return [];
  const projects: BoxProjectListPayload["projects"] = [];
  for (const entry of parsed) {
    const row = entry as Record<string, unknown>;
    if (typeof row?.projectId !== "string" || typeof row.path !== "string") continue;
    const state = typeof row.state === "string" && STATES.has(row.state) ? row.state : "unregistered";
    projects.push({
      projectId: row.projectId,
      name: typeof row.name === "string" ? row.name : row.path,
      path: row.path,
      state: state as BoxProjectListPayload["projects"][number]["state"],
      display: typeof row.display === "string" ? row.display : row.path,
      boundary: typeof row.boundary === "string" && row.boundary !== "" ? row.boundary : null,
      reason: typeof row.reason === "string" && row.reason !== "" ? row.reason : null,
    });
  }
  return projects;
}

function normaliseChecks(parsed: unknown): BoxProjectReportPayload["checks"] {
  if (!Array.isArray(parsed)) return [];
  const checks: BoxProjectReportPayload["checks"] = [];
  for (const entry of parsed) {
    const row = entry as Record<string, unknown>;
    if (typeof row?.id !== "string" || typeof row.title !== "string") continue;
    const state = typeof row.state === "string" && CHECK_STATES.has(row.state) ? row.state : "note";
    checks.push({
      id: row.id,
      title: row.title,
      state: state as BoxProjectReportPayload["checks"][number]["state"],
      detail: typeof row.detail === "string" ? row.detail : "",
    });
  }
  return checks;
}
