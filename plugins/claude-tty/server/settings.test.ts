import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { settingsFilePath } from "./paths.ts";
import { DEFAULT_IDLE_TIMEOUT_MS, IDLE_TIMEOUT_ENV } from "../shared/settings.ts";
import { updateSettings } from "./settings.ts";

const pluginRoot = path.resolve(import.meta.dirname, "..");

/**
 * The settings file and the checkout are both read out of the environment, so a test owns both:
 * a cache directory of its own, and a daemon configuration that points this plugin at its own root.
 */
async function withHost(run: () => Promise<void>): Promise<void> {
  const home = await mkdtemp(path.join(os.tmpdir(), "claude-tty-settings-"));
  await writeFile(path.join(home, "config.json"), JSON.stringify({ plugins: { "claude-tty": { path: pluginRoot } } }));
  const previous = { cache: process.env.XDG_CACHE_HOME, paseo: process.env.PASEO_HOME, override: process.env[IDLE_TIMEOUT_ENV] };
  process.env.XDG_CACHE_HOME = home;
  process.env.PASEO_HOME = home;
  delete process.env[IDLE_TIMEOUT_ENV];
  try {
    await run();
  } finally {
    restore("XDG_CACHE_HOME", previous.cache);
    restore("PASEO_HOME", previous.paseo);
    restore(IDLE_TIMEOUT_ENV, previous.override);
    await rm(home, { force: true, recursive: true });
  }
}

function restore(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

test("saves the timeout to the plugin's own settings file", async () => {
  await withHost(async () => {
    const status = await updateSettings(7_200_000);

    assert.equal(status.settings.idleTimeoutMs, 7_200_000);
    assert.equal(status.settings.file, settingsFilePath());
    assert.equal(status.settings.envOverrideMs, null);
    assert.equal(status.repoRoot, path.resolve(pluginRoot, "..", ".."));
    assert.deepEqual(JSON.parse(await readFile(settingsFilePath(), "utf8")), { version: 1, settings: { idleTimeoutMs: 7_200_000 } });
  });
});

test("reports an environment that pins the timeout, which the adapter honours over this setting", async () => {
  await withHost(async () => {
    process.env[IDLE_TIMEOUT_ENV] = "60000";
    const status = await updateSettings(900_000);
    assert.equal(status.settings.idleTimeoutMs, 900_000);
    assert.equal(status.settings.envOverrideMs, 60_000);
  });
});

test("refuses a timeout that is not a whole number of milliseconds in range", async () => {
  await withHost(async () => {
    await assert.rejects(updateSettings(-1), /integer from 0/);
    await assert.rejects(updateSettings(1.5), /integer from 0/);
    await assert.rejects(updateSettings(2_147_483_648), /integer from 0/);
  });
});

test("reads back the default until something is saved", async () => {
  await withHost(async () => {
    const status = await updateSettings(DEFAULT_IDLE_TIMEOUT_MS);
    assert.equal(status.settings.idleTimeoutMs, DEFAULT_IDLE_TIMEOUT_MS);
  });
});
