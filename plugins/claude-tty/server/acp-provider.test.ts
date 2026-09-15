import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import { runAcpProvider } from "@getpaseo/plugin/server/acp";
import type { ProviderEvent } from "@getpaseo/plugin/server/provider";
import { adapterBinaryPath, adapterDirectory, repoRootFromPluginPath } from "./paths.ts";

const EVENT_TIMEOUT_MS = 60_000;

/**
 * The bridge the plugin provider runs on builds its model and thinking pickers from ACP config options and
 * from nothing else, so the only thing that proves the adapter publishes usable ones is the bridge itself.
 * It spawns the *built* adapter, which is why this builds it first; opening a session is cheap because the
 * adapter creates one lazily and starts no Claude process until something prompts it.
 */
test("hands the plugin ACP bridge a model catalogue, thought levels, and a session opened on a chosen model", { timeout: 180_000 }, async (t) => {
  const root = repoRootFromPluginPath(path.join(import.meta.dirname, ".."));
  await promisify(execFile)(path.join(adapterDirectory(root), "node_modules", ".bin", "tsc"), ["-p", "tsconfig.build.json"], {
    cwd: adapterDirectory(root),
  });

  const home = await mkdtemp(path.join(os.tmpdir(), "claude-tty-acp-bridge-"));
  const cwd = path.join(home, "workspace");
  await mkdir(cwd, { recursive: true });
  // The bridge spawns the adapter from this process's environment, so a throwaway state directory has to be
  // set here as well as passed: it is what keeps the run out of the developer's own sessions, locks and logs.
  const env = {
    ...process.env,
    PASEO_HOME: path.join(home, "paseo"),
    CLAUDE_TTY_ACP_STATE_DIR: path.join(home, "state"),
    CLAUDE_CONFIG_DIR: path.join(home, "claude"),
  };
  Object.assign(process.env, env);

  const events: ProviderEvent[] = [];
  const connection = await runAcpProvider({
    id: "claude-tty-under-test",
    label: "Claude TTY",
    command: [adapterBinaryPath(root)],
  }).connect({ versions: [1], capabilities: ["prompt.message", "session.configure"] });
  t.after(async () => {
    await connection.close();
    await rm(home, { force: true, recursive: true });
  });
  connection.onEvent((event) => events.push(event));

  await connection.send({ type: "catalog", requestId: "catalog", cwd });
  const catalog = await settled(events, "catalog");
  assert.equal(catalog.type, "catalog");
  assert.ok(catalog.catalog.models.some((model) => model.id === "claude-opus-5"));
  assert.equal(catalog.catalog.defaultModel, "inherit");
  assert.deepEqual(
    catalog.catalog.thinkingOptions?.map((option) => option.id),
    ["inherit", "low", "medium", "high", "xhigh", "max"],
  );
  assert.equal(catalog.catalog.defaultThinkingOption, "inherit");
  assert.deepEqual(
    catalog.catalog.modes.map((mode) => mode.id),
    ["default", "acceptEdits", "plan", "auto", "bypassPermissions"],
  );

  await connection.send({
    type: "session.open",
    requestId: "open",
    sessionId: "session-under-test",
    history: "skip",
    config: {
      cwd,
      env: {},
      mcpServers: {},
      settings: {},
      persist: false,
      model: "claude-opus-5",
      mode: "plan",
      thinkingOption: "xhigh",
    },
  });
  await settled(events, "session.ready");

  const config = events.findLast((event) => event.type === "session.config");
  assert.equal(config?.config.model, "claude-opus-5");
  assert.equal(config?.config.mode, "plan");
  assert.equal(config?.config.thinkingOption, "xhigh");

  await connection.send({ type: "session.close", requestId: "close", sessionId: "session-under-test" });
  await settled(events, "request.completed");
});

/** Waits for the named event, and fails on the bridge's own failure rather than on the timeout it would cause. */
async function settled<Type extends ProviderEvent["type"]>(events: ProviderEvent[], type: Type): Promise<Extract<ProviderEvent, { type: Type }>> {
  const deadline = Date.now() + EVENT_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const failure = events.find((event) => event.type === "request.failed" || event.type === "session.runtime_failed");
    if (failure && "error" in failure) throw new Error(`${failure.type}: ${failure.error.message}`);
    const found = events.find((event) => event.type === type);
    if (found) return found as Extract<ProviderEvent, { type: Type }>;
    await delay(25);
  }
  throw new Error(`No ${type} arrived; saw ${events.map((event) => event.type).join(", ")}`);
}
