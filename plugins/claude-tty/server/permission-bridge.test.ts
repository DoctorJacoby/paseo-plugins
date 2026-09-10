import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { ProviderConnection, ProviderEvent, ProviderInput, ProviderPermissionRequest } from "@getpaseo/plugin/server/provider";
import { cardAnswersFileName } from "./card-answers.ts";
import { withPermissionCards } from "./permission-bridge.ts";

type Harness = {
  connection: ProviderConnection;
  sent: ProviderInput[];
  seen: ProviderEvent[];
  raise(request: ProviderPermissionRequest): void;
  resolve(permissionId: string): void;
  answers: string;
};

async function harness(): Promise<Harness> {
  const answers = await mkdtemp(path.join(os.tmpdir(), "claude-tty-card-answers-"));
  const sent: ProviderInput[] = [];
  const seen: ProviderEvent[] = [];
  let emit: (event: ProviderEvent) => void = () => undefined;
  const inner: ProviderConnection = {
    version: 1,
    capabilities: ["permission"],
    async send(input) {
      sent.push(input);
    },
    onEvent(listener) {
      emit = listener;
      return () => undefined;
    },
    async close() {},
  };
  const connection = withPermissionCards(inner, answers);
  connection.onEvent((event) => seen.push(event));
  return {
    connection,
    sent,
    seen,
    answers,
    raise: (request) => emit({ type: "session.permission", sessionId: "session", request }),
    resolve: (permissionId) => emit({ type: "session.permission_resolved", sessionId: "session", permissionId }),
  };
}

function questionRequest(id = "permission:toolu_1-questions"): ProviderPermissionRequest {
  return {
    id,
    name: "AskUserQuestion",
    kind: "tool",
    title: "AskUserQuestion",
    input: { questions: [{ question: "Which runtime?", header: "Runtime", options: [{ label: "Node" }, { label: "Bun" }] }] },
    actions: [
      { id: "submit", label: "Submit answers", behavior: "allow" },
      { id: "answer-0-0", label: "Node", behavior: "allow" },
      { id: "reply-in-chat", label: "Answer in chat", behavior: "deny" },
    ],
  };
}

function permissionResponse(input: ProviderInput | undefined): unknown {
  return input?.type === "session.permission" ? input.response : null;
}

test("republishes the two permissions that ask a person, and passes every other one through", async () => {
  const { raise, seen } = await harness();
  raise(questionRequest());
  raise({ id: "permission:toolu_2", name: "ExitPlanMode", kind: "tool", title: "ExitPlanMode", input: { plan: "1. Do it" } });
  raise({ id: "permission:toolu_3", name: "Bash: pnpm test", kind: "tool", title: "Bash: pnpm test", input: { command: "pnpm test" } });

  assert.deepEqual(
    seen.map((event) => (event.type === "session.permission" ? [event.request.kind, event.request.title] : null)),
    [
      ["question", "Which runtime?"],
      ["plan", "Approve Claude's plan"],
      ["tool", "Bash: pnpm test"],
    ],
  );
});

test("leaves the answers a question form collected where the adapter reads them", async () => {
  const { connection, raise, sent, answers } = await harness();
  raise(questionRequest());

  await connection.send({
    type: "session.permission",
    sessionId: "session",
    permissionId: "permission:toolu_1-questions",
    response: { behavior: "allow", updatedInput: { questions: [], answers: { Runtime: "Node, Bun" } } },
  });

  const document = await readFile(path.join(answers, cardAnswersFileName("toolu_1-questions")), "utf8");
  assert.deepEqual(JSON.parse(document), { answers: { "Which runtime?": "Node, Bun" } });
  // What goes down the ACP connection is the option that carries no answer of its own.
  assert.deepEqual(permissionResponse(sent[0]), { behavior: "allow", selectedActionId: "submit" });
});

test("forwards an answer given as an action alone untouched, with nothing to read", async () => {
  const { connection, raise, sent, answers } = await harness();
  raise(questionRequest());

  await connection.send({
    type: "session.permission",
    sessionId: "session",
    permissionId: "permission:toolu_1-questions",
    response: { behavior: "allow", selectedActionId: "answer-0-0" },
  });
  await connection.send({
    type: "session.permission",
    sessionId: "session",
    permissionId: "permission:toolu_1-questions",
    response: { behavior: "deny", message: "Dismissed by user" },
  });

  assert.deepEqual(permissionResponse(sent[0]), { behavior: "allow", selectedActionId: "answer-0-0" });
  assert.deepEqual(permissionResponse(sent[1]), { behavior: "deny", message: "Dismissed by user" });
  assert.equal(await readFile(path.join(answers, cardAnswersFileName("toolu_1-questions")), "utf8").catch(() => null), null);
});

test("lets go of a card the provider resolved on its own", async () => {
  const { connection, raise, resolve, sent } = await harness();
  raise(questionRequest());
  resolve("permission:toolu_1-questions");

  const response = { behavior: "allow", updatedInput: { answers: { Runtime: "Node" } } } as const;
  await connection.send({ type: "session.permission", sessionId: "session", permissionId: "permission:toolu_1-questions", response });

  assert.deepEqual(permissionResponse(sent[0]), response);
});
