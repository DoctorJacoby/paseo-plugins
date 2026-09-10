import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { resolveRepoRoot } from "./checkout.ts";

/** A checkout the resolver would accept: a plugin directory two levels above the adapter's manifest. */
async function makeCheckout(root: string): Promise<string> {
  await mkdir(path.join(root, "plugins", "claude-tty"), { recursive: true });
  await mkdir(path.join(root, "apps", "claude-tty-acp"), { recursive: true });
  await writeFile(path.join(root, "apps", "claude-tty-acp", "package.json"), "{}");
  return path.join(root, "plugins", "claude-tty");
}

async function withHome(run: (home: string) => Promise<void>): Promise<void> {
  const home = await mkdtemp(path.join(os.tmpdir(), "claude-tty-checkout-"));
  try {
    await run(home);
  } finally {
    await rm(home, { force: true, recursive: true });
  }
}

async function writeConfig(home: string, plugins: unknown): Promise<void> {
  await writeFile(path.join(home, "config.json"), JSON.stringify({ plugins }));
}

test("takes the checkout from the daemon's record of where the plugin lives", async () => {
  await withHome(async (home) => {
    const checkout = await mkdtemp(path.join(os.tmpdir(), "claude-tty-repo-"));
    const pluginPath = await makeCheckout(checkout);
    await writeConfig(home, { "claude-tty": { source: "directory", path: pluginPath } });

    assert.deepEqual(await resolveRepoRoot({ PASEO_HOME: home }), { root: checkout, problem: null });
    await rm(checkout, { force: true, recursive: true });
  });
});

test("expands the daemon's default home rather than assuming PASEO_HOME is set", async () => {
  await withHome(async (home) => {
    const checkout = await mkdtemp(path.join(os.tmpdir(), "claude-tty-repo-"));
    const pluginPath = await makeCheckout(checkout);
    await mkdir(path.join(home, ".paseo"), { recursive: true });
    await writeFile(path.join(home, ".paseo", "config.json"), JSON.stringify({ plugins: { "claude-tty": { path: pluginPath } } }));

    assert.deepEqual(await resolveRepoRoot({ HOME: home }), { root: checkout, problem: null });
    await rm(checkout, { force: true, recursive: true });
  });
});

test("says which file it could not read when the daemon has no configuration there", async () => {
  await withHome(async (home) => {
    const resolved = await resolveRepoRoot({ PASEO_HOME: home });
    assert.equal(resolved.root, null);
    assert.match(resolved.problem!, /Could not read .*config\.json/);
  });
});

test("says so when the configuration does not mention this plugin", async () => {
  await withHome(async (home) => {
    await writeConfig(home, { visualreview: { path: "/opt/other" } });
    const resolved = await resolveRepoRoot({ PASEO_HOME: home });
    assert.equal(resolved.root, null);
    assert.match(resolved.problem!, /no plugin entry for "claude-tty"/);
  });
});

test("refuses a plugin directory that is not inside a paseo-plugins checkout", async () => {
  await withHome(async (home) => {
    await writeConfig(home, { "claude-tty": { path: path.join(home, "somewhere", "claude-tty") } });
    const resolved = await resolveRepoRoot({ PASEO_HOME: home });
    assert.equal(resolved.root, null);
    assert.match(resolved.problem!, /apps\/claude-tty-acp\/package\.json does not exist/);
  });
});
