import assert from "node:assert/strict";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import type { AcpStream, AcpStreamMessage } from "@getpaseo/plugin/server/acp";
import { runAcpProvider } from "@getpaseo/plugin/server/acp";
import type { ProviderEvent } from "@getpaseo/plugin/server/provider";
import { dialogPermission } from "./dialog-cards.ts";
import { CARD_WITHDRAWN_METHOD, NOTICE_METHOD, sessionNotices } from "./session-notices.ts";

const NATIVE_SESSION_ID = "native";

/**
 * Both halves of this are about what the bridge does with what it is handed, so the test drives the
 * real `runAcpProvider` with an ACP agent in front of it rather than faking the connection: a notice is
 * a vendor update the bridge turns into an event, and a withdrawal is an event the bridge has no route
 * for at all and the wrapper injects.
 */
test("turns the adapter's notices into timeline notifications, and takes back a card it withdraws", async (t) => {
  const events: ProviderEvent[] = [];
  const notices = sessionNotices();
  const connection = await runAcpProvider({
    id: "claude-tty-under-test",
    label: "Claude TTY",
    connector: () => fakeAgent(),
    transformers: [notices.transformer],
  })
    .connect({ versions: [1], capabilities: ["prompt.message", "permission"] })
    .then((inner) => notices.wrap(inner));
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
  await settled(events, "session.permission");

  const notice = events.find((event) => event.type === "session.notice");
  assert.deepEqual(notice?.type === "session.notice" ? notice.notice : null, {
    id: "dialog-dismissed-1",
    severity: "warning",
    title: "Dismissed Claude's question: Add the Playwright plugin?",
    description: "The question was closed unanswered.",
  });

  // The card the adapter raised and then took back. ACP has no way to withdraw a permission request,
  // so what says so on the daemon's side is the same event an answered one ends with.
  const permission = events.find((event) => event.type === "session.permission");
  const resolved = events.find((event) => event.type === "session.permission_resolved");
  assert.equal(permission?.type === "session.permission" ? permission.request.id : null, "permission:dialog-1");
  assert.equal(resolved?.type === "session.permission_resolved" ? resolved.permissionId : null, "permission:dialog-1");
  // And it comes after the request it withdraws, rather than racing it.
  assert.ok(events.indexOf(permission!) < events.indexOf(resolved!));

  // A notice missing the parts Paseo needs is dropped rather than half-emitted.
  assert.equal(events.filter((event) => event.type === "session.notice").length, 1);
});

test("gives a card standing for one of Claude's dialogs the dialog to show", () => {
  const card = dialogPermission({
    id: "permission:dialog-1",
    name: "Add the Playwright plugin?",
    kind: "tool",
    title: "Add the Playwright plugin?",
    input: {
      claudeDialog: true,
      waitingFor: "dialog open",
      question: "Claude Code can use the Playwright plugin for this project.",
      choices: ["Yes, add it", "No thanks"],
      terminal: "❯ 1. Yes, add it\n  2. No thanks",
    },
    actions: [
      { id: "dialog-dismiss", label: "Dismiss (Esc)", behavior: "deny" },
      { id: "dialog-choice-0", label: "Yes, add it", behavior: "deny" },
    ],
  });

  assert.equal(card?.title, "Claude Code can use the Playwright plugin for this project.");
  // The dialog as drawn, because the reading that produced the buttons is best-effort and the text is
  // what makes a dialog nothing here could parse answerable by a person.
  assert.ok(card?.description?.includes("1. Yes, add it"));
  assert.deepEqual(card?.detail, { type: "plain_text", label: "Claude's terminal", text: "❯ 1. Yes, add it\n  2. No thanks", icon: "wrench" });
  // The actions are the adapter's and are left exactly as they were.
  assert.deepEqual(card?.actions, [
    { id: "dialog-dismiss", label: "Dismiss (Esc)", behavior: "deny" },
    { id: "dialog-choice-0", label: "Yes, add it", behavior: "deny" },
  ]);
  // Every other permission is somebody else's to rebuild.
  assert.equal(dialogPermission({ id: "permission:1", name: "Bash", kind: "tool", title: "Bash", input: { command: "ls" } }), null);
});

async function settled(events: ProviderEvent[], type: ProviderEvent["type"]): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (events.some((event) => event.type === type)) return;
    await delay(10);
  }
  throw new Error(`No ${type} event arrived: ${events.map((event) => event.type).join(", ")}`);
}

/**
 * An ACP agent that raises a permission, sends the two vendor notifications this is about, and leaves
 * the permission unanswered — which is the state a withdrawn card is in.
 */
function fakeAgent(): AcpStream {
  let send: (message: AcpStreamMessage) => void = () => undefined;
  const readable = new ReadableStream<AcpStreamMessage>({
    start(controller) {
      send = (message) => controller.enqueue(message);
    },
  });
  const writable = new WritableStream<AcpStreamMessage>({
    write(message) {
      if (!("method" in message)) return;
      if (message.method === "initialize") {
        send({ jsonrpc: "2.0", id: idOf(message), result: { protocolVersion: 1, agentCapabilities: { promptCapabilities: { image: true, embeddedContext: true } } } });
        return;
      }
      if (message.method === "session/new") {
        send({ jsonrpc: "2.0", id: idOf(message), result: { sessionId: NATIVE_SESSION_ID, modes: null, models: null, configOptions: [] } });
        return;
      }
      if (message.method === "session/prompt") {
        send({
          jsonrpc: "2.0",
          id: "permission-1",
          method: "session/request_permission",
          params: {
            sessionId: NATIVE_SESSION_ID,
            toolCall: { toolCallId: "dialog-1", title: "Add the Playwright plugin?", kind: "other", status: "pending", rawInput: { claudeDialog: true } },
            options: [{ optionId: "dialog-dismiss", name: "Dismiss (Esc)", kind: "reject_once" }],
          },
        });
        send({
          jsonrpc: "2.0",
          method: NOTICE_METHOD,
          params: {
            sessionId: NATIVE_SESSION_ID,
            notice: {
              id: "dialog-dismissed-1",
              severity: "warning",
              title: "Dismissed Claude's question: Add the Playwright plugin?",
              description: "The question was closed unanswered.",
            },
          },
        });
        // A notice with nothing to show carries no title, and is dropped rather than drawn empty.
        send({ jsonrpc: "2.0", method: NOTICE_METHOD, params: { sessionId: NATIVE_SESSION_ID, notice: { id: "no-title" } } });
        send({ jsonrpc: "2.0", method: CARD_WITHDRAWN_METHOD, params: { sessionId: NATIVE_SESSION_ID, toolCallId: "dialog-1" } });
        return;
      }
      if ("id" in message && message.id !== null && message.id !== undefined) {
        send({ jsonrpc: "2.0", id: idOf(message), result: {} });
      }
    },
  });
  return { readable, writable };
}

function idOf(message: AcpStreamMessage): string | number | null {
  return "id" in message && message.id !== undefined ? message.id : null;
}
