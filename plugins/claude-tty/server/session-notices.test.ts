import assert from "node:assert/strict";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import type { AcpStream, AcpStreamMessage } from "@getpaseo/plugin/server/acp";
import { runAcpProvider } from "@getpaseo/plugin/server/acp";
import type { ProviderEvent } from "@getpaseo/plugin/server/provider";
import { dialogPermission } from "./dialog-cards.ts";
import { CARD_WITHDRAWN_METHOD, MODEL_CHANGED_METHOD, NOTICE_METHOD, sessionNotices } from "./session-notices.ts";

const NATIVE_SESSION_ID = "native";

/**
 * All three of these are about what the bridge does with what it is handed, so the test drives the real
 * `runAcpProvider` with an ACP agent in front of it rather than faking the connection: a notice is a
 * vendor update the bridge turns into an event, a withdrawal is an event the bridge has no route for at
 * all and the wrapper injects, and a model change is the configuration the bridge itself published with
 * one field moved.
 */
test("turns the adapter's notices into timeline notifications, and takes back a card it withdraws", async (t) => {
  const events: ProviderEvent[] = [];
  const answers: Array<{ id: string | number | null; result: unknown }> = [];
  const notices = sessionNotices();
  const connection = await runAcpProvider({
    id: "claude-tty-under-test",
    label: "Claude TTY",
    connector: () => fakeAgent(answers),
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

  // The card the adapter raised and then took back. ACP cannot withdraw a permission request, so the
  // wrapper answers it instead, and the bridge ends it exactly as it ends one a person answered.
  await settled(events, "session.permission_resolved");
  const permission = events.find((event) => event.type === "session.permission");
  const resolved = events.find((event) => event.type === "session.permission_resolved");
  assert.equal(permission?.type === "session.permission" ? permission.request.id : null, "permission:dialog-1");
  assert.equal(resolved?.type === "session.permission_resolved" ? resolved.permissionId : null, "permission:dialog-1");
  assert.ok(events.indexOf(permission!) < events.indexOf(resolved!));
  // The agent's own request is answered, which is what takes the card out of the bridge's pending map.
  assert.deepEqual(
    answers.map((answer) => answer.id),
    ["permission-1"],
  );
  assert.deepEqual(answers[0]!.result, { outcome: { outcome: "selected", optionId: "dialog-dismiss" } });

  // Withdraw, then raise another: only the new one is still pending, and answering it ends that one and
  // nothing else. Before this the withdrawn card was still in the bridge's map and came back on screen
  // as pending the next time a card was raised.
  await settled(events, "session.permission", 2);
  await connection.send({ type: "session.permission", sessionId: "session", permissionId: "permission:dialog-2", response: { behavior: "deny" } });
  await settled(events, "session.permission_resolved", 2);
  for (let attempt = 0; attempt < 200 && answers.length < 2; attempt += 1) await delay(10);
  assert.deepEqual(
    events.filter((event) => event.type === "session.permission_resolved").map((event) => (event.type === "session.permission_resolved" ? event.permissionId : "")),
    ["permission:dialog-1", "permission:dialog-2"],
  );
  assert.deepEqual(
    answers.map((answer) => answer.id),
    ["permission-1", "permission-2"],
  );
  // Answering a card that is no longer open is what the bridge calls the session failing, so nothing
  // here answers one twice: a session that had fallen over would be showing that instead.
  assert.ok(!events.some((event) => event.type === "session.runtime_failed"));

  // A notice missing the parts Paseo needs is dropped rather than half-emitted.
  assert.equal(events.filter((event) => event.type === "session.notice").length, 1);

  // The model the session is actually on, which ACP has no update for: the configuration the bridge
  // published, with one field moved. The model this session's catalogue does not list is ignored, so the
  // last configuration to go out is the switch Claude really made.
  const configs = events.filter((event) => event.type === "session.config");
  assert.equal(configs.at(-1)?.type === "session.config" ? configs.at(-1)!.config.model : null, "claude-opus-4-8");
  assert.deepEqual(
    configs.at(-1)?.type === "session.config" ? configs.at(-1)!.config.models.map((model) => model.id) : [],
    ["claude-fable-5", "claude-opus-4-8"],
  );
  assert.ok(!configs.some((event) => event.type === "session.config" && event.config.model === "claude-from-the-future"));
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

  // The title stays the one the adapter read off the dialog; the description is what it said under it.
  assert.equal(card?.title, "Add the Playwright plugin?");
  assert.ok(card?.description?.startsWith("Claude Code can use the Playwright plugin for this project."));
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

async function settled(events: ProviderEvent[], type: ProviderEvent["type"], count = 1): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (events.filter((event) => event.type === type).length >= count) return;
    await delay(10);
  }
  throw new Error(`No ${type} event arrived: ${events.map((event) => event.type).join(", ")}`);
}

/**
 * An ACP agent that publishes a model picker, raises a card, withdraws it, raises a second one, and
 * keeps whatever it is answered — a withdrawn card is one the agent stopped waiting for, and what the
 * bridge does with the request behind it is the whole of this.
 */
function fakeAgent(answers: Array<{ id: string | number | null; result: unknown }>): AcpStream {
  let send: (message: AcpStreamMessage) => void = () => undefined;
  const readable = new ReadableStream<AcpStreamMessage>({
    start(controller) {
      send = (message) => controller.enqueue(message);
    },
  });
  const writable = new WritableStream<AcpStreamMessage>({
    write(message) {
      if (!("method" in message)) {
        if ("result" in message) answers.push({ id: message.id, result: message.result });
        return;
      }
      if (message.method === "initialize") {
        send({ jsonrpc: "2.0", id: idOf(message), result: { protocolVersion: 1, agentCapabilities: { promptCapabilities: { image: true, embeddedContext: true } } } });
        return;
      }
      if (message.method === "session/new") {
        send({
          jsonrpc: "2.0",
          id: idOf(message),
          result: {
            sessionId: NATIVE_SESSION_ID,
            modes: null,
            models: null,
            configOptions: [
              {
                id: "model",
                name: "Model",
                category: "model",
                type: "select",
                currentValue: "claude-fable-5",
                options: [
                  { value: "claude-fable-5", name: "Fable 5" },
                  { value: "claude-opus-4-8", name: "Opus 4.8" },
                ],
              },
            ],
          },
        });
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
        // The next question Claude opens, raised after the first card was taken back.
        send({
          jsonrpc: "2.0",
          id: "permission-2",
          method: "session/request_permission",
          params: {
            sessionId: NATIVE_SESSION_ID,
            toolCall: { toolCallId: "dialog-2", title: "Rewind", kind: "other", status: "pending", rawInput: { claudeDialog: true } },
            options: [{ optionId: "dialog-dismiss", name: "Dismiss (Esc)", kind: "reject_once" }],
          },
        });
        // Claude swapped the model under the session, and then again to one this session never offered.
        send({ jsonrpc: "2.0", method: MODEL_CHANGED_METHOD, params: { sessionId: NATIVE_SESSION_ID, model: "claude-opus-4-8" } });
        send({ jsonrpc: "2.0", method: MODEL_CHANGED_METHOD, params: { sessionId: NATIVE_SESSION_ID, model: "claude-from-the-future" } });
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
