import os from "node:os";
import type { DoctorPayload } from "../shared/contracts.ts";
import { parseDiagnosticsReport } from "./diagnostics.ts";
import { adapterBinaryPath } from "./paths.ts";
import { runCommand } from "./exec.ts";
import { resolveRepoRoot } from "./checkout.ts";

const DIAGNOSE_TIMEOUT_MS = 60_000;

/** Kept so a report run from the command centre is still there when the surface opens. */
let lastReport: DoctorPayload | null = null;

export function lastDoctorReport(): DoctorPayload | null {
  return lastReport;
}

/**
 * The daemon reports a session that would not open, but the ACP shim drops the adapter's stderr, so
 * the adapter's own host checks — Claude on the daemon's `PATH` above all — are only readable by
 * running them.
 */
export async function runDoctor(): Promise<DoctorPayload> {
  const repo = await resolveRepoRoot();
  const binary = repo.root === null ? null : adapterBinaryPath(repo.root);
  lastReport = { ranAt: Date.now(), adapter: { binary, ...(await checkAdapter(binary, repo.root ?? os.tmpdir())) } };
  return lastReport;
}

async function checkAdapter(binary: string | null, cwd: string): Promise<Omit<DoctorPayload["adapter"], "binary">> {
  if (binary === null) return { ok: false, problem: "There is no adapter to diagnose yet.", checks: [] };
  const result = await runCommand(binary, ["--diagnose", "--json"], { cwd, timeoutMs: DIAGNOSE_TIMEOUT_MS });
  if (result.spawnError !== null) return { ok: false, problem: `${binary} could not run: ${result.spawnError}`, checks: [] };
  const report = parseDiagnosticsReport(result.stdout);
  if (report === null) {
    const output = [result.stdout.trimEnd(), result.stderr.trimEnd()].filter((part) => part !== "").join("\n");
    return {
      ok: false,
      problem: `${binary} did not report its checks as JSON${result.exitCode === null ? "" : ` and exited ${result.exitCode}`}.${output === "" ? "" : `\n${output}`}`,
      checks: [],
    };
  }
  return { ok: report.ok, problem: null, checks: report.checks };
}
