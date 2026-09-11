import { mkdir, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";

/**
 * Mirrored by `apps/claude-tty-acp/src/card-answers.ts`, which reads these documents; keep the two
 * copies in step, because a name that drifts reads as a card nobody answered.
 *
 * Paseo carries a question card's answers as the permission response's `updatedInput`, but the ACP
 * bridge in `@getpaseo/plugin` collapses that response to the id of the option it matched and drops
 * the rest, and there is nothing else on the ACP connection that would carry them. So they are
 * written here first and the response forwarded after, which is what lets the adapter treat a
 * missing document as an answer nobody gave.
 */
export function cardAnswersFileName(cardId: string): string {
  return `${cardId.replace(/[^A-Za-z0-9._-]/g, "-")}.json`;
}

/** A card the adapter never read leaks a document; anything this old belongs to a session that is gone. */
const STALE_ANSWERS_MS = 60 * 60 * 1_000;

/** Written whole under a temporary name in the same directory, so the adapter only ever opens a complete document. */
export async function writeCardAnswers(directory: string, cardId: string, answers: Record<string, string>): Promise<void> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const file = path.join(directory, cardAnswersFileName(cardId));
  const pending = `${file}.${process.pid}.tmp`;
  await writeFile(pending, `${JSON.stringify({ answers })}\n`, { mode: 0o600 });
  await rename(pending, file);
  await sweepStaleAnswers(directory);
}

async function sweepStaleAnswers(directory: string): Promise<void> {
  const entries = await readdir(directory).catch(() => []);
  const deadline = Date.now() - STALE_ANSWERS_MS;
  await Promise.all(
    entries.map(async (entry) => {
      const file = path.join(directory, entry);
      const modified = await stat(file).then((stats) => stats.mtimeMs, () => null);
      if (modified !== null && modified < deadline) await rm(file, { force: true }).catch(() => undefined);
    }),
  );
}
