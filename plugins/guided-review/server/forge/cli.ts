import type { z } from "zod";
import type { CommandResult, CommandRunner } from "../command-runner.ts";
import { ForgeError } from "./port.ts";

export type CliOptions = {
  run: CommandRunner;
  /** The executable, read from the settings at every call because the setting can change. */
  binary: () => Promise<string>;
  /** How the tool is named in a message: `gh`. */
  name: string;
  /** Laid over the daemon's environment for every call. */
  env: Record<string, string>;
  /** Taken out of the daemon's environment for every call. */
  unsetEnv?: readonly string[];
};

export type CallOptions = {
  /** Written to stdin; the tool reads it with `--input -`. */
  input?: string;
  timeoutMs?: number;
};

/** A call that prints a file, whose stdout comes back base64-encoded rather than decoded as text. */
type FileCall = CallOptions & { maxBytes: number };

/** Long enough for a paginated file list on a large PR, short enough that a hung call ends. */
export const DEFAULT_CLI_TIMEOUT_MS = 120_000;

/** The CLI is not where the settings say, which for a reviewer on only the other forge means it is not installed. */
export class CliNotFoundError extends ForgeError {
  override name = "CliNotFoundError";
}

/** One forge CLI, whose failures come back as a `ForgeError` in a sentence. */
export type Cli = {
  text(args: readonly string[], options?: CallOptions): Promise<string>;
  json<Schema extends z.ZodType>(schema: Schema, args: readonly string[], options?: CallOptions): Promise<z.output<Schema>>;
  /** One document per line, each read by `schema`: what `glab api --paginate --output ndjson` prints. */
  ndjson<Schema extends z.ZodType>(schema: Schema, args: readonly string[], options?: CallOptions): Promise<z.output<Schema>[]>;
  /** Whether the call exits cleanly, for a probe whose failure is an answer rather than an error. */
  succeeds(args: readonly string[], options?: CallOptions): Promise<boolean>;
  /**
   * Everything the call printed, stdout then stderr, whatever it exited with: what a command reports
   * when it reports on several things at once, some of which may have failed.
   */
  report(args: readonly string[], options?: CallOptions): Promise<string>;
  /** A file the call prints, base64-encoded, refused once it passes `maxBytes`. */
  bytes(args: readonly string[], options: FileCall): Promise<string>;
};

export function createCli(options: CliOptions): Cli {
  /** Runs the call, and fails only when it did not run to an exit code. */
  const run = async (args: readonly string[], call: CallOptions & Partial<FileCall> = {}): Promise<CommandResult> => {
    const binary = await options.binary();
    const result = await options.run({
      file: binary,
      args,
      env: options.env,
      ...(options.unsetEnv === undefined ? {} : { unsetEnv: options.unsetEnv }),
      timeoutMs: call.timeoutMs ?? DEFAULT_CLI_TIMEOUT_MS,
      ...(call.input === undefined ? {} : { input: call.input }),
      ...(call.maxBytes === undefined ? {} : { stdoutEncoding: "base64", maxStdoutBytes: call.maxBytes }),
    });
    if (result.outputExceeded && call.maxBytes !== undefined) {
      throw new ForgeError(`The file is larger than ${megabytes(call.maxBytes)}.`);
    }
    if (result.spawnError !== null) {
      if (/ENOENT|EACCES/.test(result.spawnError)) {
        const message = `Could not run ${options.name} at "${binary}" (${result.spawnError}). Set the ${options.name} path in the Guided Review settings.`;
        throw /ENOENT/.test(result.spawnError) ? new CliNotFoundError(message) : new ForgeError(message);
      }
      throw new ForgeError(`${options.name} did not finish: ${result.spawnError}.`);
    }
    return result;
  };

  const text = async (args: readonly string[], call?: CallOptions & Partial<FileCall>) => {
    const result = await run(args, call);
    if (result.exitCode !== 0) {
      throw new ForgeError(`${options.name} failed: ${reason(result.stderr, options.name) ?? `exit code ${result.exitCode}`}`);
    }
    return result.stdout;
  };

  const read = <Schema extends z.ZodType>(schema: Schema, document: string): z.output<Schema> => {
    let value: unknown;
    try {
      value = JSON.parse(document);
    } catch {
      throw new ForgeError(`${options.name} answered with something that is not JSON.`);
    }
    const parsed = schema.safeParse(value);
    if (!parsed.success) {
      throw new ForgeError(`${options.name} answered in a shape this plugin does not know: ${parsed.error.issues[0]?.message ?? "invalid"}.`);
    }
    return parsed.data;
  };

  return {
    text,
    async json(schema, args, call) {
      return read(schema, await text(args, call));
    },
    async ndjson(schema, args, call) {
      const stdout = await text(args, call);
      return stdout
        .split("\n")
        .filter((line) => line.trim() !== "")
        .map((line) => read(schema, line));
    },
    async succeeds(args, call) {
      return (await run(args, call)).exitCode === 0;
    },
    async report(args, call) {
      const result = await run(args, call);
      return `${result.stdout}${result.stderr}`;
    },
    bytes: text,
  };
}

function megabytes(bytes: number): string {
  return `${Math.round((bytes / (1024 * 1024)) * 10) / 10} MB`;
}

/**
 * The CLI's own words, without its `gh:` prefix and without whatever it printed after the first
 * line. `glab` prints some errors as a box instead, an `ERROR` title over an `X` line it wraps, so
 * for those the reason is everything under the title.
 */
function reason(stderr: string, name: string): string | null {
  const [line, ...rest] = stderr
    .split("\n")
    .map((entry) => entry.trim())
    .filter((entry) => entry !== "");
  if (line === undefined) return null;
  if (line === "ERROR" && rest.length > 0) return rest.join(" ").replace(/^X /, "");
  return line.startsWith(`${name}: `) ? line.slice(name.length + 2) : line;
}
