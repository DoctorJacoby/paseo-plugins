import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { PaseoApi } from "@getpaseo/client";
import { readLegacyProvider } from "./upgrade.ts";

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
