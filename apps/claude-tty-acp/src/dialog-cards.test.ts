import assert from "node:assert/strict";
import test from "node:test";
import type { AgentSideConnection, RequestPermissionRequest, RequestPermissionResponse } from "@agentclientprotocol/sdk";
import { type DialogMenu, DialogWatcher } from "./dialog-cards.ts";
import { InteractionBridge } from "./interactions.ts";
import { CARD_WITHDRAWN_METHOD, NOTICE_METHOD } from "./vendor-updates.ts";

const DIALOG_SCREEN = [
  "Claude Code can use the Playwright plugin for this project.",
  "❯ 1. Yes, add it",
  "  2. No thanks",
  "Enter to confirm · Esc to cancel",
].join("\n");

const IDLE_SCREEN = ["❯", "  ⏸ manual mode on"].join("\n");

type Harness = {
  watcher: DialogWatcher;
  permissions: RequestPermissionRequest[];
  vendor: Array<{ method: string; params: Record<string, unknown> }>;
  menus: DialogMenu[];
  escapes: number;
  answer(response: RequestPermissionResponse): void;
  setWaitingFor(value: string | null): void;
  setScreen(value: string): void;
  interactions: InteractionBridge;
};

function harness(options: { answerMenu?: (menu: DialogMenu) => Promise<"confirmed" | "gone" | "stuck">; startupScreen?: string } = {}): Harness {
  const permissions: RequestPermissionRequest[] = [];
  const vendor: Array<{ method: string; params: Record<string, unknown> }> = [];
  const menus: DialogMenu[] = [];
  let resolvePermission: ((response: RequestPermissionResponse) => void) | null = null;
  let waitingFor: string | null = null;
  let screen = IDLE_SCREEN;
  const state = { escapes: 0 };
  const connection = {
    sessionUpdate: async () => undefined,
    extNotification: async (method: string, params: Record<string, unknown>) => {
      vendor.push({ method, params });
    },
    requestPermission: (request: RequestPermissionRequest) => {
      permissions.push(request);
      return new Promise<RequestPermissionResponse>((resolve) => {
        resolvePermission = resolve;
      });
    },
  } as unknown as AgentSideConnection;
  const interactions = new InteractionBridge("session-1", "/work", connection);
  const watcher = new DialogWatcher({
    sessionId: "session-1",
    connection,
    interactions,
    waitingFor: async () => waitingFor,
    screen: () => screen,
    escape: () => {
      state.escapes += 1;
    },
    answerMenu: async (menu) => {
      menus.push(menu);
      return (await options.answerMenu?.(menu)) ?? "confirmed";
    },
    answeredByStartup: (value) => options.startupScreen !== undefined && value === options.startupScreen,
    pollIntervalMs: 10,
    answerKeyMs: 1,
    answerTimeoutMs: 50,
    settleMs: 100,
  });
  return {
    watcher,
    permissions,
    vendor,
    menus,
    get escapes() {
      return state.escapes;
    },
    interactions,
    answer: (response) => resolvePermission?.(response),
    setWaitingFor: (value) => {
      waitingFor = value;
    },
    setScreen: (value) => {
      screen = value;
    },
  };
}

async function waitFor(condition: () => boolean, timeoutMs = 1_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("Timed out waiting for test condition");
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
}

test("raises a card with a button per row, and every one of them a declining option", async (t) => {
  const test1 = harness();
  t.after(() => test1.watcher.stop());
  test1.watcher.start();
  test1.setScreen(DIALOG_SCREEN);
  test1.setWaitingFor("dialog open");
  await waitFor(() => test1.permissions.length === 1);

  const request = test1.permissions[0]!;
  assert.equal(request.toolCall.title, "Claude Code can use the Playwright plugin for this project.");
  assert.deepEqual(request.options, [
    // Dismiss first: an answer that names no action takes the first option of its behaviour, and every
    // option here has the same one, because a question Claude is waiting on must never be answered by
    // Paseo's automatic modes.
    { optionId: "dialog-dismiss", name: "Dismiss (Esc)", kind: "reject_once" },
    { optionId: "dialog-choice-0", name: "Yes, add it", kind: "reject_once" },
    { optionId: "dialog-choice-1", name: "No thanks", kind: "reject_once" },
  ]);
  const input = request.toolCall.rawInput as Record<string, unknown>;
  assert.equal(input.claudeDialog, true);
  assert.equal(input.waitingFor, "dialog open");
  // The dialog as drawn rides along, so a reading that found no rows is still answerable by a person.
  assert.ok(String(input.terminal).includes("Enter to confirm"));

  // One card for the question, not one per poll.
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(test1.permissions.length, 1);
});

test("answers by moving Claude's own marker, and reads its state back", async (t) => {
  const test2 = harness({
    answerMenu: async (menu) => {
      // The marker is on the first row; the menu is what moves it, so this stands in for the keys.
      assert.ok(menu.onScreen(DIALOG_SCREEN));
      assert.ok(!menu.selected(DIALOG_SCREEN));
      test2.setScreen(DIALOG_SCREEN.replace("❯ 1.", "  1.").replace("  2.", "❯ 2."));
      return "confirmed";
    },
  });
  t.after(() => test2.watcher.stop());
  test2.watcher.start();
  test2.setScreen(DIALOG_SCREEN);
  test2.setWaitingFor("dialog open");
  await waitFor(() => test2.permissions.length === 1);

  test2.answer({ outcome: { outcome: "selected", optionId: "dialog-choice-1" } });
  await waitFor(() => test2.menus.length === 1);
  // Claude stops saying it is waiting, which is the only proof the answer landed.
  test2.setWaitingFor(null);
  assert.ok(test2.menus[0]!.selected(DIALOG_SCREEN.replace("❯ 1.", "  1.").replace("  2.", "❯ 2.")));
  assert.equal(test2.escapes, 0);
});

test("escapes the question when the card is dismissed, and when the row cannot be reached", async (t) => {
  const dismissed = harness();
  t.after(() => dismissed.watcher.stop());
  dismissed.watcher.start();
  dismissed.setScreen(DIALOG_SCREEN);
  dismissed.setWaitingFor("dialog open");
  await waitFor(() => dismissed.permissions.length === 1);
  dismissed.answer({ outcome: { outcome: "selected", optionId: "dialog-dismiss" } });
  await waitFor(() => dismissed.escapes === 1);
  dismissed.setWaitingFor(null);

  const stuck = harness({ answerMenu: async () => "stuck" });
  t.after(() => stuck.watcher.stop());
  stuck.watcher.start();
  stuck.setScreen(DIALOG_SCREEN);
  stuck.setWaitingFor("dialog open");
  await waitFor(() => stuck.permissions.length === 1);
  stuck.answer({ outcome: { outcome: "selected", optionId: "dialog-choice-0" } });
  // A row the marker will not go to leaves the question closed rather than pressed at: an unanswered
  // question of Claude's is what stops every later prompt to this session.
  await waitFor(() => stuck.escapes === 1);
  stuck.setWaitingFor(null);
});

test("takes the card down when the question closes by itself", async (t) => {
  const test4 = harness();
  t.after(() => test4.watcher.stop());
  test4.watcher.start();
  test4.setScreen(DIALOG_SCREEN);
  test4.setWaitingFor("dialog open");
  await waitFor(() => test4.permissions.length === 1);

  // Claude closes two of its nudges after thirty seconds whatever anybody does.
  test4.setScreen(IDLE_SCREEN);
  test4.setWaitingFor(null);
  await waitFor(() => test4.vendor.some((update) => update.method === CARD_WITHDRAWN_METHOD));
  const withdrawal = test4.vendor.find((update) => update.method === CARD_WITHDRAWN_METHOD)!;
  assert.equal(withdrawal.params.toolCallId, test4.permissions[0]!.toolCall.toolCallId);
  // Nothing was pressed into a question that is no longer there.
  assert.equal(test4.escapes, 0);
  assert.equal(test4.menus.length, 0);
});

test("says in the timeline which question a prompt dismissed", async (t) => {
  const test5 = harness();
  t.after(() => test5.watcher.stop());
  test5.watcher.start();
  test5.setScreen(DIALOG_SCREEN);
  test5.setWaitingFor("dialog open");
  await waitFor(() => test5.permissions.length === 1);

  await test5.watcher.dismissedForPrompt("dialog open");
  const notice = test5.vendor.find((update) => update.method === NOTICE_METHOD);
  const details = notice?.params.notice as { severity: string; title: string; description: string };
  assert.equal(details.severity, "warning");
  assert.ok(details.title.includes("Playwright"));
  assert.ok(details.description.includes("Yes, add it"));
  // And the card goes with it: the question it stood for is gone.
  assert.ok(test5.vendor.some((update) => update.method === CARD_WITHDRAWN_METHOD));
});

test("leaves the dialogs the adapter answers itself alone, and the ones a hook is already asking about", async (t) => {
  const startup = harness({ startupScreen: "the workspace trust screen" });
  t.after(() => startup.watcher.stop());
  startup.watcher.start();
  startup.setScreen("the workspace trust screen");
  startup.setWaitingFor("dialog open");
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.equal(startup.permissions.length, 0);

  const hooked = harness();
  t.after(() => hooked.watcher.stop());
  // A permission card of Claude's own is open and waiting for an answer; the session is `waiting` for
  // exactly that, and a second card would be a second answer to one question.
  void hooked.interactions.requestWorkspaceTrust();
  await waitFor(() => hooked.permissions.length === 1);
  hooked.watcher.start();
  hooked.setScreen(DIALOG_SCREEN);
  hooked.setWaitingFor("permission prompt");
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.equal(hooked.permissions.length, 1);
  hooked.interactions.cancelPending();
});
