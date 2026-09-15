import { APP_NAME, APP_VERSION } from "./constants.ts";

export type CliAction =
  | { kind: "serve"; settingsFile: string | null }
  | { kind: "print"; text: string }
  | { kind: "diagnose"; json: boolean };

const HELP = `Usage: ${APP_NAME} [--settings-file <path>] [--help | --version | --diagnose [--json]]

Runs the interactive Claude Code ACP adapter over stdin/stdout.
Use --settings-file to name a JSON document holding an idleTimeoutMs; Paseo's Claude TTY plugin passes the one its settings screen writes.
Use --diagnose to check this host without starting ACP, and --json to get one machine-readable line instead of the report.
`;

export function parseCliArgs(args: string[]): CliAction {
  if (args.length === 0) return { kind: "serve", settingsFile: null };
  if (args.length === 1 && (args[0] === "--help" || args[0] === "-h")) {
    return { kind: "print", text: HELP };
  }
  if (args.length === 1 && (args[0] === "--version" || args[0] === "-V")) {
    return { kind: "print", text: APP_VERSION };
  }
  if (args.length === 1 && args[0] === "--diagnose") return { kind: "diagnose", json: false };
  if (args.length === 2 && args.includes("--diagnose") && args.includes("--json")) return { kind: "diagnose", json: true };
  // A path never starts with a dash, so a missing value reads as an unknown flag rather than as one.
  const settingsFile = args.length === 2 && args[0] === "--settings-file" ? args[1] : undefined;
  if (settingsFile !== undefined && settingsFile !== "" && !settingsFile.startsWith("-")) {
    return { kind: "serve", settingsFile };
  }
  throw new Error(`Unknown arguments: ${args.join(" ")}`);
}
