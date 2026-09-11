import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { claudeTtyProvider } from "./provider.ts";

/**
 * The catalogue is compiled into the adapter, so one key covers every workspace and collapses the
 * daemon's `["target", cwd]` fallback — a throwaway adapter per distinct directory — to one fetch.
 * What it must still tell apart is a rebuilt adapter, since that is where a new catalogue comes from.
 */
test("shares one catalogue across workspaces and gives a rebuilt adapter a key of its own", async (t) => {
  const home = await mkdtemp(path.join(os.tmpdir(), "claude-tty-catalogue-"));
  t.after(() => rm(home, { force: true, recursive: true }));
  const checkout = path.join(home, "checkout");
  const adapter = path.join(checkout, "apps", "claude-tty-acp");
  await mkdir(path.join(adapter, "dist"), { recursive: true });
  await writeFile(path.join(adapter, "package.json"), "{}");
  await mkdir(path.join(home, "paseo"), { recursive: true });
  await writeFile(
    path.join(home, "paseo", "config.json"),
    JSON.stringify({ plugins: { "claude-tty": { path: path.join(checkout, "plugins", "claude-tty") } } }),
  );
  process.env.PASEO_HOME = path.join(home, "paseo");
  const key = async (cwd: string): Promise<string | undefined> =>
    claudeTtyProvider().getCatalogCacheKey?.({ scope: "workspace", cwd });

  // An adapter nobody has built yet still answers with one key, so the failure is reported once.
  const unbuilt = await key("/work/one");
  assert.match(String(unbuilt), /:unbuilt$/);
  assert.equal(await key("/work/two"), unbuilt);

  const entry = path.join(adapter, "dist", "cli.js");
  await writeFile(entry, "// built");
  const built = await key("/work/one");
  assert.notEqual(built, unbuilt);
  assert.equal(await key("/work/two"), built);

  await writeFile(entry, "// built again, and longer than before");
  assert.notEqual(await key("/work/one"), built);
});
