import assert from "node:assert/strict";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { runAcpProvider } from "@getpaseo/plugin/server/acp";
import type { AcpStream, AcpStreamMessage } from "@getpaseo/plugin/server/acp";
import type { ProviderConnection, ProviderEvent, ProviderInput } from "@getpaseo/plugin/server/provider";
import { STEER_CAPABILITY, withSteerFallback } from "./steering.ts";

const NATIVE_SESSION_ID = "native";

const OFFERED = ["prompt.message", STEER_CAPABILITY];

/**
 * The bridge is what cannot steer, so the test drives the real `runAcpProvider` against an ACP agent
 * whose turn stays open until it is cancelled — the one state a steer is ever sent in.
 */
test("answers a steer during a running turn without touching the turn", async (t) => {
  // One agent per connect, as for the adapter: the bridge probes capabilities on one it then closes.
  let agent = fakeAgent();
  const events: ProviderEvent[] = [];
  const connector = () => {
    agent = fakeAgent();
    return agent.stream;
  };
  const connection = await runAcpProvider({ id: "claude-tty-under-test", label: "Claude TTY", connector })
    .connect({ versions: [1], capabilities: OFFERED })
    .then((inner) => withSteerFallback(inner, OFFERED));
  t.after(() => connection.close());
  connection.onEvent((event) => events.push(event));

  assert.ok(connection.capabilities.includes(STEER_CAPABILITY));
  await connection.send(open("session"));
  const opened = await settled(events, (event) => event.type === "session.opened");
  assert.ok(opened.type === "session.opened" && opened.capabilities.includes(STEER_CAPABILITY));
  await settled(events, (event) => event.type === "session.ready");

  await connection.send(prompt("session", "first", "auto"));
  await settled(events, (event) => event.type === "session.turn" && event.state === "started");

  await connection.send(prompt("session", "second", "steer"));
  const answer = await settled(events, (event) => event.type === "session.prompt_result" && event.clientMessageId === "second");
  // Anything but an accepted steer is the daemon's cue to interrupt the turn and send this as the next.
  assert.ok(answer.type === "session.prompt_result" && answer.result.type === "failed");

  // The replacing is the daemon's to do, so the running turn is still Claude's and nothing reached it.
  await delay(50);
  assert.deepEqual(agent.received, ["initialize", "session/new", "session/prompt"]);
  assert.equal(events.filter((event) => event.type === "session.turn").length, 1);
  assert.ok(!events.some((event) => event.type === "request.failed" || event.type === "session.runtime_failed"));
});

/**
 * This is the bug itself, kept as a canary: once the SDK's bridge steers on its own this fails, and
 * the wrapper steps aside for it.
 */
test("the bridge on its own refuses a steer", async (t) => {
  const connection = await runAcpProvider({ id: "claude-tty-under-test", label: "Claude TTY", connector: () => fakeAgent().stream }).connect({
    versions: [1],
    capabilities: OFFERED,
  });
  t.after(() => connection.close());
  const events: ProviderEvent[] = [];
  connection.onEvent((event) => events.push(event));
  await connection.send(open("session"));
  await settled(events, (event) => event.type === "session.ready");

  assert.ok(!connection.capabilities.includes(STEER_CAPABILITY));
  await assert.rejects(connection.send(prompt("session", "steer", "steer")), /does not support prompt\.steer/);
});

test("passes everything but a steer through, and offers it to no child session", async () => {
  const inner = fakeConnection();
  const connection = withSteerFallback(inner.connection, OFFERED);
  const events: ProviderEvent[] = [];
  connection.onEvent((event) => events.push(event));

  await connection.send(prompt("session", "message", "auto"));
  assert.deepEqual(inner.sent, [prompt("session", "message", "auto")]);

  inner.emit({ type: "session.opened", sessionId: "child", parentSessionId: "session", capabilities: [], restoration: "parent", cwd: "/repo" });
  assert.deepEqual(events.at(-1), { type: "session.opened", sessionId: "child", parentSessionId: "session", capabilities: [], restoration: "parent", cwd: "/repo" });
});

test("leaves the connection alone for a daemon that offers no steering", () => {
  const inner = fakeConnection();
  assert.equal(withSteerFallback(inner.connection, ["prompt.message"]), inner.connection);
});

test("refuses a steer once the connection is closed", async () => {
  const connection = withSteerFallback(fakeConnection().connection, OFFERED);
  await connection.close();
  await assert.rejects(connection.send(prompt("session", "late", "steer")), /closed/);
});

function open(sessionId: string): ProviderInput {
  return {
    type: "session.open",
    requestId: `open-${sessionId}`,
    sessionId,
    history: "skip",
    config: { cwd: "/repo", env: {}, mcpServers: {}, settings: {}, persist: false },
  };
}

function prompt(sessionId: string, clientMessageId: string, delivery: "auto" | "steer"): ProviderInput {
  return {
    type: "session.prompt",
    sessionId,
    prompt: { clientMessageId, delivery, input: { type: "message", content: [{ type: "text", text: clientMessageId }] } },
  };
}

/** Waits for a matching event, and fails on the bridge's own failure rather than on the timeout it would cause. */
async function settled(events: ProviderEvent[], matches: (event: ProviderEvent) => boolean): Promise<ProviderEvent> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const failure = events.find((event) => event.type === "request.failed" || event.type === "session.runtime_failed");
    if (failure && "error" in failure) throw new Error(`${failure.type}: ${failure.error.message}`);
    const found = events.find(matches);
    if (found) return found;
    await delay(5);
  }
  throw new Error(`No matching event arrived; saw ${events.map((event) => event.type).join(", ")}`);
}

function fakeConnection(): { connection: ProviderConnection; sent: ProviderInput[]; emit(event: ProviderEvent): void } {
  const sent: ProviderInput[] = [];
  let emit: (event: ProviderEvent) => void = () => undefined;
  return {
    sent,
    emit: (event) => emit(event),
    connection: {
      version: 1,
      capabilities: ["prompt.message"],
      async send(input) {
        sent.push(input);
      },
      onEvent(listener) {
        emit = listener;
        return () => undefined;
      },
      async close() {},
    },
  };
}

/** An ACP agent whose prompt stays open until it is cancelled, and which records every method it is sent. */
function fakeAgent(): { stream: AcpStream; received: string[] } {
  const received: string[] = [];
  let push: (message: AcpStreamMessage) => void = () => undefined;
  const readable = new ReadableStream<AcpStreamMessage>({
    start(controller) {
      push = (message) => controller.enqueue(message);
    },
  });
  let openPrompt: string | number | null = null;
  const writable = new WritableStream<AcpStreamMessage>({
    write(message) {
      if (!("method" in message)) return;
      received.push(message.method);
      const id = "id" in message ? message.id : null;
      if (message.method === "initialize") {
        push({ jsonrpc: "2.0", id, result: { protocolVersion: 1, agentCapabilities: {} } });
        return;
      }
      if (message.method === "session/new") {
        push({ jsonrpc: "2.0", id, result: { sessionId: NATIVE_SESSION_ID, modes: null, configOptions: [] } });
        return;
      }
      if (message.method === "session/prompt") {
        openPrompt = id;
        return;
      }
      if (message.method === "session/cancel") {
        if (openPrompt !== null) push({ jsonrpc: "2.0", id: openPrompt, result: { stopReason: "cancelled" } });
        openPrompt = null;
        return;
      }
      if (id !== null) push({ jsonrpc: "2.0", id, result: {} });
    },
  });
  return { stream: { readable, writable }, received };
}
