export type DiagnosticCheck = { id: string; label: string; ok: boolean; detail: string };

export type DiagnosticsReport = { version: string | null; ok: boolean; checks: DiagnosticCheck[] };

/**
 * The adapter prints its report as one JSON line on stdout, but anything the daemon's environment
 * writes ahead of it lands there too, so only the last line is the report.
 */
export function parseDiagnosticsReport(stdout: string): DiagnosticsReport | null {
  const line = stdout.trim().split("\n").at(-1);
  if (line === undefined || line === "") return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const record = parsed as Record<string, unknown>;
  if (typeof record.ok !== "boolean" || !Array.isArray(record.checks)) return null;
  const checks = record.checks.filter(isCheck);
  if (checks.length !== record.checks.length) return null;
  return { version: typeof record.version === "string" ? record.version : null, ok: record.ok, checks };
}

function isCheck(value: unknown): value is DiagnosticCheck {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.id === "string" &&
    typeof record.label === "string" &&
    typeof record.ok === "boolean" &&
    typeof record.detail === "string"
  );
}
