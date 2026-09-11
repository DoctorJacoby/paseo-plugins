import assert from "node:assert/strict";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { runAcpProvider } from "@getpaseo/plugin/server/acp";
import type { AcpStream, AcpStreamMessage } from "@getpaseo/plugin/server/acp";
import type { ProviderEvent, ProviderToolCallDetail } from "@getpaseo/plugin/server/provider";
import { TOOL_CALL_MIRROR_METHOD, toolCallDetails } from "./tool-details.ts";

const NATIVE_SESSION_ID = "native";

/**
 * The bridge is the whole point of this: it is what drops the fields a card is made of, and what
 * decides the order the mirror and the update it copies arrive in. So the test drives the real
 * `runAcpProvider` and stands an ACP agent up in front of it rather than faking the connection.
 */
test("turns the adapter's mirrored tool calls into the cards the bridge cannot build", async (t) => {
  const events: ProviderEvent[] = [];
  const details = toolCallDetails();
  const connection = await runAcpProvider({
    id: "claude-tty-under-test",
    label: "Claude TTY",
    connector: () => fakeAgent(),
    transformers: [details.transformer],
  })
    .connect({ versions: [1], capabilities: ["prompt.message"] })
    .then((inner) => details.wrap(inner));
  t.after(() => connection.close());
  connection.onEvent((event) => events.push(event));

  await connection.send({
    type: "session.open",
    requestId: "open",
    sessionId: "session",
    history: "skip",
    config: { cwd: "/repo", env: {}, mcpServers: {}, settings: {}, persist: false },
  });
  await settled(events, "session.ready");
  await connection.send({
    type: "session.prompt",
    sessionId: "session",
    prompt: { clientMessageId: "message", delivery: "auto", input: { type: "message", content: [{ type: "text", text: "go" }] } },
  });
  await settled(events, "session.turn");

  // A command shows its output, which lived in the content blocks the bridge threw away.
  assert.deepEqual(lastDetail(events, "shell-call"), {
    type: "shell",
    command: "npm test",
    cwd: "/repo",
    output: "3 passing",
    exitCode: undefined,
  });
  // An edit shows its diff, which the bridge would have looked for under ACP's own key names.
  assert.deepEqual(lastDetail(events, "edit-call"), {
    type: "edit",
    filePath: "/repo/src/app.ts",
    oldString: "before",
    newString: "after",
    unifiedDiff: undefined,
  });
  // A tool nothing has a card for shows the text it produced, which is how a subagent's log arrives.
  assert.deepEqual(lastDetail(events, "agent-call"), {
    type: "plain_text",
    label: "Agent: Audit the API",
    text: "Read src/app.ts\nReported back",
    icon: "wrench",
  });
  // And a call the adapter never mirrored is left exactly as the bridge made it.
  assert.deepEqual(lastDetail(events, "unmirrored-call"), { type: "unknown", input: { command: "ls" }, output: null });
});

test("forgets a closed session's tool calls", async () => {
  const details = toolCallDetails();
  const events: ProviderEvent[] = [];
  let emit: (event: ProviderEvent) => void = () => undefined;
  const connection = details.wrap({
    version: 1,
    capabilities: [],
    async send() {},
    onEvent(listener) {
      emit = listener;
      return () => undefined;
    },
    async close() {},
  });
  connection.onEvent((event) => events.push(event));

  details.transformer.notification?.(
    { method: TOOL_CALL_MIRROR_METHOD, params: { update: { toolCallId: "call", kind: "execute", rawInput: { command: "ls" } } } },
    { sessionId: "session" },
  );
  emit({ type: "session.closed", sessionId: "session" });
  emit({ type: "timeline.item", sessionId: "session", item: toolCall("call") });

  assert.deepEqual(lastDetail(events, "call"), { type: "unknown", input: null, output: null });
});

function lastDetail(events: readonly ProviderEvent[], callId: string): ProviderToolCallDetail | undefined {
  const item = events.findLast((event) => event.type === "timeline.item" && event.item.type === "tool_call" && event.item.callId === callId);
  return item?.type === "timeline.item" && item.item.type === "tool_call" ? item.item.detail : undefined;
}

function toolCall(callId: string): Extract<ProviderEvent, { type: "timeline.item" }>["item"] {
  return { type: "tool_call", id: callId, callId, name: callId, status: "running", error: null, detail: { type: "unknown", input: null, output: null } };
}

/** Waits for the named event, and fails on the bridge's own failure rather than on the timeout it would cause. */
async function settled<Type extends ProviderEvent["type"]>(events: ProviderEvent[], type: Type): Promise<Extract<ProviderEvent, { type: Type }>> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const failure = events.find((event) => event.type === "request.failed" || event.type === "session.runtime_failed");
    if (failure && "error" in failure) throw new Error(`${failure.type}: ${failure.error.message}`);
    const found = events.find((event) => event.type === type);
    if (found) return found as Extract<ProviderEvent, { type: Type }>;
    await delay(5);
  }
  throw new Error(`No ${type} arrived; saw ${events.map((event) => event.type).join(", ")}`);
}

/**
 * An ACP agent that answers a prompt with the tool calls the adapter would send, each mirrored the
 * way the adapter mirrors it: the vendor notification first, the update it copies behind it.
 */
function fakeAgent(): AcpStream {
  let push: (message: AcpStreamMessage) => void = () => undefined;
  const readable = new ReadableStream<AcpStreamMessage>({
    start(controller) {
      push = (message) => controller.enqueue(message);
    },
  });
  const update = (value: Record<string, unknown>, mirrored = true): void => {
    if (mirrored) push({ jsonrpc: "2.0", method: TOOL_CALL_MIRROR_METHOD, params: { sessionId: NATIVE_SESSION_ID, update: value } });
    push({ jsonrpc: "2.0", method: "session/update", params: { sessionId: NATIVE_SESSION_ID, update: value } });
  };
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
        update({
          sessionUpdate: "tool_call",
          toolCallId: "shell-call",
          title: "Bash: npm test",
          kind: "execute",
          status: "in_progress",
          rawInput: { command: "npm test", cwd: "/repo" },
          content: [{ type: "content", content: { type: "text", text: "npm test" } }],
        });
        update({
          sessionUpdate: "tool_call_update",
          toolCallId: "shell-call",
          status: "completed",
          rawOutput: [{ type: "text", text: "3 passing" }],
          content: [{ type: "content", content: { type: "text", text: "3 passing" } }],
        });
        update({
          sessionUpdate: "tool_call",
          toolCallId: "edit-call",
          title: "Edit: src/app.ts",
          kind: "edit",
          status: "in_progress",
          rawInput: { file_path: "src/app.ts", old_string: "before", new_string: "after" },
          locations: [{ path: "/repo/src/app.ts" }],
          content: [{ type: "diff", path: "/repo/src/app.ts", oldText: "before", newText: "after" }],
        });
        update({
          sessionUpdate: "tool_call",
          toolCallId: "agent-call",
          title: "Agent: Audit the API",
          kind: "other",
          status: "in_progress",
          rawInput: { description: "Audit the API" },
        });
        // The subagent card carries its log and nothing else, the way the adapter republishes one.
        update({
          sessionUpdate: "tool_call_update",
          toolCallId: "agent-call",
          status: "completed",
          content: [{ type: "content", content: { type: "text", text: "Read src/app.ts\nReported back" } }],
        });
        update(
          {
            sessionUpdate: "tool_call",
            toolCallId: "unmirrored-call",
            title: "Bash: ls",
            kind: "execute",
            status: "in_progress",
            rawInput: { command: "ls" },
          },
          false,
        );
        push({ jsonrpc: "2.0", id, result: { stopReason: "end_turn" } });
        return;
      }
      if (id !== null) push({ jsonrpc: "2.0", id, result: {} });
    },
  });
  return { readable, writable };
}
