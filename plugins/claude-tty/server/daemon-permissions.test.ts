import assert from "node:assert/strict";
import { createRequire } from "node:module";
import path from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import type { AcpStream, AcpStreamMessage } from "@getpaseo/plugin/server/acp";
import { runAcpProvider } from "@getpaseo/plugin/server/acp";
import type { ProviderConnection } from "@getpaseo/plugin/server/provider";
import { withPermissionCards } from "./permission-bridge.ts";
import { sessionNotices } from "./session-notices.ts";

/**
 * What the daemon does with a card, against the daemon's own code.
 *
 * A withdrawal is only worth anything if it reaches the list Paseo rebuilds its pending permissions
 * from, and that list is inside `@getpaseo/server`: `PluginAgentSession.getPendingPermissions()`, which
 * `AgentManager` copies wholesale into the agent on every answered permission --
 * `respondToPermission` → `refreshSessionState` → `agent.pendingPermissions = new Map(pending)`.
 *
 * The other half of why that matters is `cancelAgentRun`, which Paseo runs before it replaces a turn:
 * it calls `resolvePendingPermissionsForAgent`, which clears the *agent's* copy and tells the provider
 * nothing at all. So a card the provider still holds is invisible until the next answer and then comes
 * back from the dead, on top of whatever is on screen by then -- which is exactly what a session did
 * live on 2026-09-16, bringing back a `/model` card a prompt had closed a minute earlier.
 *
 * The daemon is not a dependency of this plugin -- it is what installs it -- so this runs only where a
 * copy is to hand: `PASEO_SERVER_DIST` pointing at an installed `@getpaseo/server`, or one resolvable
 * from here. Otherwise it skips, and says how to run it.
 */
const require = createRequire(import.meta.url);

function pluginProviderModule(): string | null {
  const configured = process.env.PASEO_SERVER_DIST?.trim();
  const candidates = configured
    ? [path.join(configured, "dist/server/server/agent/plugin-provider.js"), configured]
    : ["@getpaseo/server/dist/server/server/agent/plugin-provider.js"];
  for (const candidate of candidates) {
    try {
      return require.resolve(candidate);
    } catch {}
  }
  return null;
}

const NATIVE_SESSION_ID = "native";

test("keeps the daemon's own pending permissions in step with the cards a session really has", async (t) => {
  const modulePath = pluginProviderModule();
  if (modulePath === null) {
    t.skip("No @getpaseo/server to hand: install one and point PASEO_SERVER_DIST at it to run this");
    return;
  }
  const { PluginAgentClientRegistry } = (await import(modulePath)) as { PluginAgentClientRegistry: new (logger: unknown) => Registry };

  const agent = fakeAdapter();
  const registry = new PluginAgentClientRegistry({ warn: () => undefined, info: () => undefined, error: () => undefined, debug: () => undefined });
  registry.replace([
    {
      id: "claude-tty-under-test",
      label: "Claude TTY",
      async connect(request: { versions: number[]; capabilities: string[] }): Promise<ProviderConnection> {
        const notices = sessionNotices();
        const connection = await runAcpProvider({
          id: "claude-tty-under-test",
          label: "Claude TTY",
          connector: () => agent.stream(),
          transformers: [notices.transformer],
        }).connect(request);
        return withPermissionCards(notices.wrap(connection), "/tmp/claude-tty-daemon-test-answers");
      },
    },
  ]);
  t.after(() => registry.shutdown());

  const client = registry.clients()["claude-tty-under-test"]!;
  const session = await client.createSession({ provider: "claude-tty-under-test", cwd: "/tmp" }, { env: {} }, { persistSession: false });
  const provider = (): string[] => session.getPendingPermissions().map((request) => request.id);
  // The agent's own copy of that list, kept the four ways `AgentManager` keeps it. The two that follow
  // the session's events are subscribed below; the other two are the sequence this reproduces.
  const agentCards = new Set<string>();
  session.subscribe((event) => {
    if (event.type === "permission_requested" && event.request) agentCards.add(event.request.id);
    if (event.type === "permission_resolved" && event.requestId) agentCards.delete(event.requestId);
  });
  /** `cancelAgentRun` → `resolvePendingPermissionsForAgent`: the agent's copy, and only that. */
  const interrupt = (): void => agentCards.clear();
  /** `respondToPermission` → `refreshSessionState`: the agent's copy, rebuilt from the provider's. */
  const refresh = (): void => {
    agentCards.clear();
    for (const id of provider()) agentCards.add(id);
  };

  // 1. Claude opens a question during a turn, and the card goes up.
  agent.raise("dialog-a", "Select model");
  await settled(() => provider().length === 1);
  assert.deepEqual([...agentCards], ["permission:dialog-a"]);

  // 2. The next message. Paseo cancels the run first, which drops the agent's copy of that card and
  //    tells the provider nothing -- and the adapter, having closed the question to get the keyboard
  //    back, takes the card down for real.
  interrupt();
  agent.withdraw("dialog-a");
  await settled(() => provider().length === 0);
  // The agent's own request is answered, which is the only thing that empties the provider's list.
  assert.deepEqual(agent.answers, [{ id: "rpc-dialog-a", optionId: "dialog-dismiss" }]);

  // 3. The next question opens and is carded.
  agent.raise("dialog-b", "Rewind");
  await settled(() => provider().length === 1);

  // 4. Somebody answers it, the way the app does.
  await session.respondToPermission("permission:dialog-b", { behavior: "deny", selectedActionId: "dialog-choice-0" });
  await settled(() => provider().length === 0);
  refresh();

  // 5. And nothing comes back with it. This is what failed live: the `/model` card a prompt had closed
  //    a minute earlier was back on screen the moment the next card was answered.
  assert.deepEqual([...agentCards], []);
  assert.deepEqual(
    agent.answers.map((answer) => answer.id),
    ["rpc-dialog-a", "rpc-dialog-b"],
  );
});

test("ends the dialog card a session already had open when the next one is raised", async (t) => {
  const modulePath = pluginProviderModule();
  if (modulePath === null) {
    t.skip("No @getpaseo/server to hand: install one and point PASEO_SERVER_DIST at it to run this");
    return;
  }
  const { PluginAgentClientRegistry } = (await import(modulePath)) as { PluginAgentClientRegistry: new (logger: unknown) => Registry };
  const agent = fakeAdapter();
  const registry = new PluginAgentClientRegistry({ warn: () => undefined, info: () => undefined, error: () => undefined, debug: () => undefined });
  registry.replace([
    {
      id: "claude-tty-one-at-a-time",
      label: "Claude TTY",
      async connect(request: { versions: number[]; capabilities: string[] }): Promise<ProviderConnection> {
        const notices = sessionNotices();
        const connection = await runAcpProvider({
          id: "claude-tty-one-at-a-time",
          label: "Claude TTY",
          connector: () => agent.stream(),
          transformers: [notices.transformer],
        }).connect(request);
        return withPermissionCards(notices.wrap(connection), "/tmp/claude-tty-daemon-test-answers");
      },
    },
  ]);
  t.after(() => registry.shutdown());

  const client = registry.clients()["claude-tty-one-at-a-time"]!;
  const session = await client.createSession({ provider: "claude-tty-one-at-a-time", cwd: "/tmp" }, { env: {} }, { persistSession: false });

  // A session holds one question at a time, so a card for a new one says the old one is over. This is
  // the backstop for every way a withdrawal can go missing: without it the old card comes back.
  agent.raise("dialog-a", "Select model");
  await settled(() => session.getPendingPermissions().length === 1);
  agent.raise("dialog-b", "Rewind");
  await settled(() => session.getPendingPermissions().map((request) => request.id).join() === "permission:dialog-b");
  assert.deepEqual(
    session.getPendingPermissions().map((request) => request.id),
    ["permission:dialog-b"],
  );
  assert.deepEqual(agent.answers, [{ id: "rpc-dialog-a", optionId: "dialog-dismiss" }]);
});

/**
 * The daemon behaviour that makes the withdrawal necessary, asserted as it stands rather than argued
 * about: a card nobody answers survives the interrupt that hid it, and the next answered card brings it
 * back. This is the canary beside the test above -- it fails the day Paseo tells the provider what it
 * did, and the withdrawal can go.
 */
test("a card nobody takes back is what the daemon brings back", async (t) => {
  const modulePath = pluginProviderModule();
  if (modulePath === null) {
    t.skip("No @getpaseo/server to hand: install one and point PASEO_SERVER_DIST at it to run this");
    return;
  }
  const { PluginAgentClientRegistry } = (await import(modulePath)) as { PluginAgentClientRegistry: new (logger: unknown) => Registry };
  const agent = fakeAdapter();
  const registry = new PluginAgentClientRegistry({ warn: () => undefined, info: () => undefined, error: () => undefined, debug: () => undefined });
  registry.replace([
    {
      id: "claude-tty-canary",
      label: "Claude TTY",
      async connect(request: { versions: number[]; capabilities: string[] }): Promise<ProviderConnection> {
        const notices = sessionNotices();
        const connection = await runAcpProvider({
          id: "claude-tty-canary",
          label: "Claude TTY",
          connector: () => agent.stream(),
          transformers: [notices.transformer],
        }).connect(request);
        return withPermissionCards(notices.wrap(connection), "/tmp/claude-tty-daemon-test-answers");
      },
    },
  ]);
  t.after(() => registry.shutdown());

  const client = registry.clients()["claude-tty-canary"]!;
  const session = await client.createSession({ provider: "claude-tty-canary", cwd: "/tmp" }, { env: {} }, { persistSession: false });
  const agentCards = new Set<string>();
  session.subscribe((event) => {
    if (event.type === "permission_requested" && event.request) agentCards.add(event.request.id);
    if (event.type === "permission_resolved" && event.requestId) agentCards.delete(event.requestId);
  });

  // Plain cards rather than Claude's dialogs, because this is about what the daemon does with a card
  // nobody ends -- a dialog card raised while an older one is open ends that older one on the way in.
  agent.raise("tool-a", "Run a command", false);
  await settled(() => session.getPendingPermissions().length === 1);
  // The interrupt, which hides it from the agent and leaves it with the provider.
  agentCards.clear();
  agent.raise("tool-b", "Run another", false);
  await settled(() => session.getPendingPermissions().length === 2);
  await session.respondToPermission("permission:tool-b", { behavior: "deny", selectedActionId: "dialog-choice-0" });
  await settled(() => session.getPendingPermissions().length === 1);
  // The rebuild, and the card that was hidden is back.
  agentCards.clear();
  for (const request of session.getPendingPermissions()) agentCards.add(request.id);
  assert.deepEqual([...agentCards], ["permission:tool-a"]);
});

type DaemonEvent =
  | { type: "permission_requested"; request: { id: string }; requestId?: undefined }
  | { type: "permission_resolved"; requestId: string; request?: undefined }
  | { type: "other"; request?: undefined; requestId?: undefined };

type DaemonSession = {
  getPendingPermissions(): Array<{ id: string }>;
  respondToPermission(requestId: string, response: { behavior: string; selectedActionId?: string }): Promise<unknown>;
  subscribe(listener: (event: DaemonEvent) => void): () => void;
};

type Registry = {
  replace(registrations: unknown[]): void;
  clients(): Record<string, { createSession(config: unknown, launchContext: unknown, options: unknown): Promise<DaemonSession> }>;
  shutdown(): Promise<void>;
};

async function settled(condition: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (condition()) return;
    await delay(10);
  }
  throw new Error("Timed out waiting for the daemon's pending permissions");
}

/** The adapter, reduced to the two things this is about: it raises cards and it takes them back. */
function fakeAdapter() {
  let send: ((message: AcpStreamMessage) => void) | null = null;
  const answers: Array<{ id: string | number | null; optionId: string | null }> = [];
  return {
    answers,
    raise(toolCallId: string, title: string, dialog = true): void {
      send?.({
        jsonrpc: "2.0",
        id: `rpc-${toolCallId}`,
        method: "session/request_permission",
        params: {
          sessionId: NATIVE_SESSION_ID,
          toolCall: { toolCallId, title, kind: "other", status: "pending", rawInput: dialog ? { claudeDialog: true } : { command: "ls" } },
          options: [
            { optionId: "dialog-dismiss", name: "Dismiss (Esc)", kind: "reject_once" },
            { optionId: "dialog-choice-0", name: "A row", kind: "reject_once" },
          ],
        },
      });
    },
    withdraw(toolCallId: string): void {
      send?.({ jsonrpc: "2.0", method: "_claude_tty/card_withdrawn", params: { sessionId: NATIVE_SESSION_ID, toolCallId } });
    },
    stream(): AcpStream {
      const readable = new ReadableStream<AcpStreamMessage>({
        start(controller) {
          send = (message) => controller.enqueue(message);
        },
      });
      const writable = new WritableStream<AcpStreamMessage>({
        write(message) {
          if (!("method" in message)) {
            const result = "result" in message ? (message.result as { outcome?: { optionId?: string } } | null) : null;
            answers.push({ id: message.id, optionId: result?.outcome?.optionId ?? null });
            return;
          }
          const id = "id" in message ? message.id : null;
          if (message.method === "initialize") {
            send?.({ jsonrpc: "2.0", id, result: { protocolVersion: 1, agentCapabilities: { promptCapabilities: {} } } });
            return;
          }
          if (message.method === "session/new") {
            send?.({ jsonrpc: "2.0", id, result: { sessionId: NATIVE_SESSION_ID, modes: null, models: null, configOptions: [] } });
            return;
          }
          if (id !== null && id !== undefined) send?.({ jsonrpc: "2.0", id, result: {} });
        },
      });
      return { readable, writable };
    },
  };
}
