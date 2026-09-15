import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { PaseoApi } from "@getpaseo/client";
import { settingsDocument } from "../shared/settings.ts";
import { legacySettingsFilePath, settingsFilePath } from "./paths.ts";
import { carryOverIdleTimeout, readLegacyProvider } from "./upgrade.ts";

async function withHome(run: (env: { HOME: string; PASEO_HOME: string }) => Promise<void>): Promise<void> {
  const home = await mkdtemp(path.join(os.tmpdir(), "claude-tty-upgrade-"));
  const env = { HOME: home, PASEO_HOME: path.join(home, ".paseo") };
  await mkdir(env.PASEO_HOME, { recursive: true });
  try {
    await run(env);
  } finally {
    await rm(home, { force: true, recursive: true });
  }
}

async function writeJson(filePath: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, JSON.stringify(value));
}

async function exists(filePath: string): Promise<boolean> {
  return stat(filePath).then(() => true, () => false);
}

/** A daemon listing these providers, one page at a time, or one that never answers. */
function fakePaseo(pages: string[][] | "stalls"): PaseoApi {
  let calls = 0;
  const list = () => {
    if (pages === "stalls") return new Promise(() => {});
    const page = pages[calls] ?? [];
    calls += 1;
    return Promise.resolve({
      entries: page.map((provider, index) => ({ agent: { id: `${calls}-${index}`, provider }, project: null })),
      pageInfo: { nextCursor: calls < pages.length ? String(calls) : null },
    });
  };
  return { agents: { list } } as unknown as PaseoApi;
}

const ADAPTER = "/opt/paseo-plugins/apps/claude-tty-acp/bin/claude-tty-acp";

test("reports the adapter's old entry and counts the agents still on it across pages", async () => {
  await withHome(async (env) => {
    await writeJson(path.join(env.PASEO_HOME, "config.json"), {
      agents: { providers: { traecli: { extends: "acp", label: "Claude TTY", command: [ADAPTER] } } },
    });
    const paseo = fakePaseo([["traecli", "claude-tty"], ["codex", "traecli"]]);
    assert.deepEqual(await readLegacyProvider(paseo, env), {
      id: "traecli",
      configFile: path.join(env.PASEO_HOME, "config.json"),
      command: ADAPTER,
      agents: 2,
    });
  });
});

test("leaves a traecli entry alone when it runs something other than this adapter", async () => {
  await withHome(async (env) => {
    await writeJson(path.join(env.PASEO_HOME, "config.json"), {
      agents: { providers: { traecli: { extends: "acp", command: ["/usr/local/bin/traecli", "acp"] } } },
    });
    assert.equal(await readLegacyProvider(fakePaseo([["traecli"]]), env), null);
  });
});

test("reports nothing without an entry, or without a configuration to read", async () => {
  await withHome(async (env) => {
    assert.equal(await readLegacyProvider(fakePaseo([]), env), null);
    await writeJson(path.join(env.PASEO_HOME, "config.json"), { agents: { providers: { pi: { command: ["pi"] } } } });
    assert.equal(await readLegacyProvider(fakePaseo([]), env), null);
  });
});

test("does not count agents it could not list them all", async () => {
  await withHome(async (env) => {
    await writeJson(path.join(env.PASEO_HOME, "config.json"), { agents: { providers: { traecli: { command: [ADAPTER] } } } });
    const reading = await readLegacyProvider(fakePaseo("stalls"), env);
    assert.equal(reading?.agents, null);
  });
});

test("carries a chosen idle timeout into the host's document and removes the old file", async () => {
  await withHome(async (env) => {
    const legacy = legacySettingsFilePath(env);
    await writeJson(legacy, { version: 1, settings: { idleTimeoutMs: 4 * 60 * 60 * 1_000 } });

    await carryOverIdleTimeout(env);

    // The shape the host's store writes, which is also what the adapter reads.
    assert.deepEqual(JSON.parse(await readFile(settingsFilePath(env), "utf8")), {
      version: 1,
      values: settingsDocument.schema.parse({ idleTimeoutMs: 4 * 60 * 60 * 1_000 }),
    });
    assert.equal(await exists(legacy), false);
    assert.equal(await exists(path.dirname(legacy)), false);
    assert.equal(await exists(path.join(env.HOME, ".cache", "paseo-plugins")), true);
  });
});

test("keeps a document the host already has, and still removes the old file", async () => {
  await withHome(async (env) => {
    const legacy = legacySettingsFilePath(env);
    await writeJson(legacy, { version: 1, settings: { idleTimeoutMs: 0 } });
    const saved = JSON.stringify({ version: 1, values: { idleTimeoutMs: 15 * 60 * 1_000 } });
    await mkdir(path.dirname(settingsFilePath(env)), { recursive: true });
    await writeFile(settingsFilePath(env), saved);

    await carryOverIdleTimeout(env);

    assert.equal(await readFile(settingsFilePath(env), "utf8"), saved);
    assert.equal(await exists(legacy), false);
  });
});

test("writes nothing for an old file the old plugin would have read as the default", async () => {
  await withHome(async (env) => {
    const legacy = legacySettingsFilePath(env);
    await mkdir(path.dirname(legacy), { recursive: true });
    await writeFile(legacy, "{ not json");

    await carryOverIdleTimeout(env);

    assert.equal(await exists(settingsFilePath(env)), false);
    assert.equal(await exists(legacy), false);
  });
});

test("reads the settings bare, the way the old plugin also accepted them", async () => {
  await withHome(async (env) => {
    await writeJson(legacySettingsFilePath(env), { idleTimeoutMs: "1800000" });
    await carryOverIdleTimeout(env);
    assert.deepEqual(JSON.parse(await readFile(settingsFilePath(env), "utf8")).values, settingsDocument.schema.parse({ idleTimeoutMs: 1_800_000 }));
  });
});

test("does nothing at all when there is no old file", async () => {
  await withHome(async (env) => {
    await carryOverIdleTimeout(env);
    assert.equal(await exists(path.dirname(settingsFilePath(env))), false);
  });
});

test("keeps the old file for the next start when the document cannot be written", async () => {
  await withHome(async (env) => {
    const legacy = legacySettingsFilePath(env);
    await writeJson(legacy, { version: 1, settings: { idleTimeoutMs: 1_800_000 } });
    // A file where the plugin's settings directory belongs makes the write fail.
    await writeFile(path.join(env.PASEO_HOME, "plugin-settings"), "");

    const warnings: unknown[] = [];
    const warn = console.warn;
    console.warn = (...args: unknown[]) => void warnings.push(args);
    try {
      await carryOverIdleTimeout(env);
    } finally {
      console.warn = warn;
    }

    assert.equal(await exists(legacy), true);
    assert.equal(warnings.length, 1);
  });
});
