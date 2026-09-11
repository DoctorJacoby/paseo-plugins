import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { AgentSideConnection, SessionConfigOption, SessionNotification } from "@agentclientprotocol/sdk";
import { HookServer } from "./hook-server.ts";
import { SessionRegistry } from "./session-registry.ts";
import { StateStore } from "./state-store.ts";

function createRegistry(): SessionRegistry {
  return new SessionRegistry({} as AgentSideConnection, new HookServer());
}

test("creates independent lazy sessions", () => {
  const registry = createRegistry();
  const first = registry.create("/work/one");
  const second = registry.create("/work/two");

  assert.notEqual(first.id, second.id);
  assert.equal(first.started, false);
  assert.equal(second.started, false);
  assert.equal(registry.size, 2);
  assert.equal(registry.get(first.id)?.cwd, "/work/one");
  assert.equal(registry.get(second.id)?.cwd, "/work/two");
});

test("rejects relative session directories", () => {
  assert.throws(() => createRegistry().create("relative/path"), /absolute path/);
});

test("clears probe-only sessions without external state", async () => {
  const registry = createRegistry();
  registry.create("/work/probe");
  await registry.clear();
  assert.equal(registry.size, 0);
});

test("loads sessions persisted before the model id rename", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "session-registry-test-"));
  const sessionId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const store = new StateStore(root);
  const registry = new SessionRegistry(
    { sessionUpdate: async () => undefined, extNotification: async () => undefined } as unknown as AgentSideConnection,
    new HookServer(),
    { claudeConfigDir: root },
    store,
  );
  try {
    await store.save({
      version: 1,
      acpSessionId: sessionId,
      claudeSessionId: sessionId,
      cwd: root,
      model: "default",
      mode: "default",
      lastActivity: 1,
    });
    const session = await registry.load(sessionId, root);
    assert.equal(session.models.currentModelId, "inherit");
  } finally {
    await registry.clear();
    await rm(root, { force: true, recursive: true });
  }
});

// An adapter rolled back past the release that added the mode leaves the session naming one this build does not offer.
test("opens a session left in a mode this adapter no longer offers", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "session-registry-test-"));
  const sessionId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
  const store = new StateStore(root);
  const registry = new SessionRegistry(
    { sessionUpdate: async () => undefined, extNotification: async () => undefined } as unknown as AgentSideConnection,
    new HookServer(),
    { claudeConfigDir: root },
    store,
  );
  try {
    await store.save({
      version: 1,
      acpSessionId: sessionId,
      claudeSessionId: sessionId,
      cwd: root,
      model: "inherit",
      mode: "modeFromALaterAdapter",
      lastActivity: 1,
    });
    const session = await registry.load(sessionId, root);
    assert.equal(session.modes.currentModeId, "default");
  } finally {
    await registry.clear();
    await rm(root, { force: true, recursive: true });
  }
});

test("reads an effort level back, and falls to the default for one it has no record of", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "session-registry-test-"));
  const store = new StateStore(root);
  const registry = new SessionRegistry(
    { sessionUpdate: async () => undefined, extNotification: async () => undefined } as unknown as AgentSideConnection,
    new HookServer(),
    { claudeConfigDir: root },
    store,
  );
  const saved = { version: 1, cwd: root, model: "inherit", mode: "default", lastActivity: 1 } as const;
  const kept = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
  const unknown = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
  // A file written before the effort selector existed carries none at all, which is the same reading as one this build does not offer.
  const absent = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
  try {
    await store.save({ ...saved, acpSessionId: kept, claudeSessionId: kept, effort: "xhigh" });
    await store.save({ ...saved, acpSessionId: unknown, claudeSessionId: unknown, effort: "effortFromALaterAdapter" });
    await store.save({ ...saved, acpSessionId: absent, claudeSessionId: absent });

    assert.equal(currentEffort(await registry.load(kept, root)), "xhigh");
    assert.equal(currentEffort(await registry.load(unknown, root)), "inherit");
    assert.equal(currentEffort(await registry.load(absent, root)), "inherit");
  } finally {
    await registry.clear();
    await rm(root, { force: true, recursive: true });
  }
});

function currentEffort(session: { configOptions: SessionConfigOption[] }): string | undefined {
  const option = session.configOptions.find((entry) => entry.category === "thought_level");
  return option?.type === "select" ? option.currentValue : undefined;
}

test("follows the host settings for the session's mode until someone switches the toggle", async () => {
  const updates: SessionNotification[] = [];
  const registry = new SessionRegistry(
    { sessionUpdate: async (update: SessionNotification) => void updates.push(update) } as unknown as AgentSideConnection,
    new HookServer(),
    { autoAcceptDefault: async (mode) => mode === "bypassPermissions" },
  );
  try {
    const session = registry.create("/work/auto-accept");
    assert.equal(await session.refreshAutoAccept({ publish: false }), false);
    assert.equal(currentAutoAccept(session), false);

    // Paseo sets the mode after the session exists, and the toggle it shows has to catch up.
    await session.setMode("bypassPermissions");
    assert.equal(currentAutoAccept(session), true);
    const published = updates.map((notification) => notification.update).filter((update) => update.sessionUpdate === "config_option_update");
    assert.equal(published.length, 1);
    assert.equal(published[0]?.sessionUpdate === "config_option_update" ? currentAutoAccept(published[0]) : undefined, true);

    const switched = await session.setConfigOption("auto_accept", false);
    assert.equal(currentAutoAccept({ configOptions: switched }), false);
    assert.equal(await session.refreshAutoAccept({ publish: true }), false);
    await session.setMode("default");
    await session.setMode("bypassPermissions");
    assert.equal(currentAutoAccept(session), false);

    await assert.rejects(session.setConfigOption("auto_accept", "true"), /takes a boolean/);
    await assert.rejects(session.setConfigOption("model", true), /not a boolean/);
  } finally {
    await registry.clear();
  }
});

test("asks when the host settings cannot be read", async () => {
  const registry = new SessionRegistry({} as AgentSideConnection, new HookServer(), {
    autoAcceptDefault: async () => {
      throw new Error("settings store unavailable");
    },
  });
  try {
    const session = registry.create("/work/auto-accept");
    assert.equal(await session.refreshAutoAccept({ publish: true }), false);
  } finally {
    await registry.clear();
  }
});

test("reads a switched toggle back, and leaves a session nobody switched following the settings", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "session-registry-test-"));
  const store = new StateStore(root);
  const registry = new SessionRegistry(
    { sessionUpdate: async () => undefined, extNotification: async () => undefined } as unknown as AgentSideConnection,
    new HookServer(),
    { claudeConfigDir: root, autoAcceptDefault: async () => true },
    store,
  );
  const saved = { version: 1, cwd: root, model: "inherit", mode: "bypassPermissions", lastActivity: 1 } as const;
  const switchedOff = "ffffffff-ffff-4fff-8fff-ffffffffffff";
  const following = "abababab-abab-4bab-8bab-abababababab";
  try {
    await store.save({ ...saved, acpSessionId: switchedOff, claudeSessionId: switchedOff, autoAccept: false });
    await store.save({ ...saved, acpSessionId: following, claudeSessionId: following });

    const off = await registry.load(switchedOff, root);
    assert.equal(await off.refreshAutoAccept({ publish: false }), false);
    const follows = await registry.load(following, root);
    assert.equal(await follows.refreshAutoAccept({ publish: false }), true);
    assert.equal((await store.load(following))?.autoAccept, undefined);

    await follows.setConfigOption("auto_accept", false);
    assert.equal((await store.load(following))?.autoAccept, false);
  } finally {
    await registry.clear();
    await rm(root, { force: true, recursive: true });
  }
});

function currentAutoAccept(session: { configOptions: SessionConfigOption[] }): boolean | undefined {
  const option = session.configOptions.find((entry) => entry.id === "auto_accept");
  return option?.type === "boolean" ? option.currentValue : undefined;
}
