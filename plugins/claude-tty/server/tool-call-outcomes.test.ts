import assert from "node:assert/strict";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { runAcpProvider } from "@getpaseo/plugin/server/acp";
import type { AcpStream, AcpStreamMessage } from "@getpaseo/plugin/server/acp";
import type { ProviderConnection, ProviderEvent, ProviderInput } from "@getpaseo/plugin/server/provider";
import { withCancelledToolCalls } from "./tool-call-outcomes.ts";

const NATIVE_SESSION_ID = "native";
const OFFERED = ["prompt.message"];

/**
 * The bridge is what makes the item, so the test drives the real `runAcpProvider` against an ACP agent
 * that leaves a tool call running into a cancelled turn — which is every message sent to a session with
 * a subagent in it, since Paseo cancels a turn before it replaces one.
 */
test("gives a tool call still running at a cancelled turn an outcome the daemon will accept", async (t) => {
  const events: ProviderEvent[] = [];
  const connection = await runAcpProvider({ id: "claude-tty-under-test", label: "Claude TTY", connector: () => fakeAgent().stream })
    .connect({ versions: [1], capabilities: OFFERED })
    .then(withCancelledToolCalls);
  t.after(() => connection.close());
  connection.onEvent((event) => events.push(event));

  await connection.send(open("session"));
  await settled(events, (event) => event.type === "session.ready");
  await connection.send(prompt("session", "first"));
  await settled(events, (event) => event.type === "timeline.item" && event.item.type === "tool_call");

  await connection.send({ type: "session.interrupt", requestId: "stop", sessionId: "session" });
  await settled(events, (event) => event.type === "session.turn" && event.state === "canceled");

  const items = events.filter((event) => event.type === "timeline.item" && event.item.type === "tool_call");
  const last = items.at(-1);
  assert.ok(last?.type === "timeline.item" && last.item.type === "tool_call");
  // `failed` with a null error is the one shape the daemon's schema has no branch for, and it does not
  // cost the card: the whole timeline response fails validation and the client refuses the agent's
  // entire history for as long as the item is in it.
  assert.notEqual(last.item.status, "failed");
  assert.equal(last.item.status, "canceled");
  assert.equal(last.item.error, null);
});

/**
 * This is the bug itself, kept as a canary: once the SDK's bridge cancels a cancelled tool call rather
 * than failing it, this fails and the wrapper can go.
 */
test("the bridge on its own fails that tool call with no error to explain it", async (t) => {
  const events: ProviderEvent[] = [];
  const connection = await runAcpProvider({ id: "claude-tty-under-test", label: "Claude TTY", connector: () => fakeAgent().stream }).connect({
    versions: [1],
    capabilities: OFFERED,
  });
  t.after(() => connection.close());
  connection.onEvent((event) => events.push(event));

  await connection.send(open("session"));
  await settled(events, (event) => event.type === "session.ready");
  await connection.send(prompt("session", "first"));
  await settled(events, (event) => event.type === "timeline.item" && event.item.type === "tool_call");
  await connection.send({ type: "session.interrupt", requestId: "stop", sessionId: "session" });
  await settled(events, (event) => event.type === "session.turn" && event.state === "canceled");

  const items = events.filter((event) => event.type === "timeline.item" && event.item.type === "tool_call");
  const last = items.at(-1);
  assert.ok(last?.type === "timeline.item" && last.item.type === "tool_call");
  assert.equal(last.item.status, "failed");
  assert.equal(last.item.error, null);
});

test("leaves a tool call that really failed alone, and everything that is not one", async () => {
  const inner = fakeConnection();
  const connection = withCancelledToolCalls(inner.connection);
  const events: ProviderEvent[] = [];
  connection.onEvent((event) => events.push(event));

  const failed = toolCall("failed", { message: "the command exited 1" });
  inner.emit(failed);
  assert.deepEqual(events.at(-1), failed);

  const running = toolCall("running", null);
  inner.emit(running);
  assert.deepEqual(events.at(-1), running);

  const opened: ProviderEvent = { type: "session.opened", sessionId: "child", capabilities: [], restoration: "core", cwd: "/repo" };
  inner.emit(opened);
  assert.deepEqual(events.at(-1), opened);
});

test("passes what it is sent straight through", async () => {
  const inner = fakeConnection();
  const connection = withCancelledToolCalls(inner.connection);
  await connection.send(prompt("session", "message"));
  assert.deepEqual(inner.sent, [prompt("session", "message")]);
});

function toolCall(status: "running" | "failed", error: unknown): ProviderEvent {
  return {
    type: "timeline.item",
    sessionId: "session",
    item: {
      type: "tool_call",
      id: "call",
      callId: "call",
      name: "Bash",
      detail: { type: "plain_text", label: "Bash", text: "ls" },
      ...(status === "failed" ? { status: "failed", error } : { status: "running", error: null }),
    },
  } as ProviderEvent;
}

function open(sessionId: string): ProviderInput {
  return {
    type: "session.open",
    requestId: `open-${sessionId}`,
    sessionId,
    history: "skip",
    config: { cwd: "/repo", env: {}, mcpServers: {}, settings: {}, persist: false },
  };
}

function prompt(sessionId: string, clientMessageId: string): ProviderInput {
  return {
    type: "session.prompt",
    sessionId,
    prompt: { clientMessageId, delivery: "auto", input: { type: "message", content: [{ type: "text", text: clientMessageId }] } },
  };
}

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

/** An ACP agent that leaves a tool call running in a prompt that only ever ends by being cancelled. */
function fakeAgent(): { stream: AcpStream } {
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
        push({
          jsonrpc: "2.0",
          method: "session/update",
          params: {
            sessionId: NATIVE_SESSION_ID,
            update: { sessionUpdate: "tool_call", toolCallId: "call", title: "Agent: count", kind: "other", status: "in_progress" },
          },
        });
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
  return { stream: { readable, writable } };
}
