import assert from "node:assert/strict";
import test from "node:test";
import type { ProviderPermissionRequest } from "@getpaseo/plugin/server/provider";
import { answersByQuestion, planPermission, questionPermission } from "./question-cards.ts";

/** What `runAcpProvider` builds out of the ACP permission the adapter raises: a plain tool card. */
function toolPermission(name: string, input: ProviderPermissionRequest["input"]): ProviderPermissionRequest {
  return {
    id: "permission:toolu_1-questions",
    name,
    kind: "tool",
    title: name,
    input,
    actions: [
      { id: "submit", label: "Submit answers", behavior: "allow" },
      { id: "reply-in-chat", label: "Answer in chat", behavior: "deny" },
    ],
  };
}

test("rebuilds Claude's questions into the shape Paseo's question form renders", () => {
  const card = questionPermission(
    toolPermission("AskUserQuestion", {
      questions: [
        {
          question: "Which runtime?",
          header: "Runtime",
          multiSelect: true,
          options: [
            { label: "Node", description: "The established one", preview: "node --version" },
            { label: "Bun", preview: "bun --version" },
            { label: 7 },
          ],
        },
      ],
    }),
  );

  assert.equal(card?.kind, "question");
  assert.deepEqual(card?.input?.questions, [
    {
      question: "Which runtime?",
      header: "Runtime",
      multiSelect: true,
      allowOther: true,
      options: [
        // The form has no preview of its own, so a preview joins the description under the label.
        { label: "Node", description: "The established one\n\nnode --version" },
        { label: "Bun", description: "bun --version" },
      ],
    },
  ]);
});

test("summarises the questions for the clients that have room for one line", () => {
  const one = questionPermission(
    toolPermission("AskUserQuestion", { questions: [{ question: "Which runtime?", header: "Runtime", options: [{ label: "Node" }, { label: "Bun" }] }] }),
  );
  const several = questionPermission(
    toolPermission("AskUserQuestion", {
      questions: [
        { question: "Which runtime?", header: "Runtime", options: [{ label: "Node" }] },
        { question: "Which checks?", header: "Checks", options: [{ label: "Types" }, { label: "Tests" }] },
      ],
    }),
  );

  assert.equal(one?.title, "Which runtime?");
  assert.equal(one?.description, "Runtime: Node / Bun");
  assert.equal(several?.title, "Which runtime? (+1 more)");
  assert.equal(several?.description, "Runtime: Node · Checks: Types / Tests");
});

test("offers a standalone action per answer only while one question is asked", () => {
  const one = questionPermission(
    toolPermission("AskUserQuestion", { questions: [{ question: "Which runtime?", header: "Runtime", options: [{ label: "Node" }, { label: "Bun" }] }] }),
  );
  const several = questionPermission(
    toolPermission("AskUserQuestion", {
      questions: [
        { question: "Which runtime?", header: "Runtime", options: [{ label: "Node" }] },
        { question: "Which checks?", header: "Checks", options: [{ label: "Types" }] },
      ],
    }),
  );

  assert.deepEqual(one?.actions, [
    { id: "answer-0-0", label: "Node", behavior: "allow" },
    { id: "answer-0-1", label: "Bun", behavior: "allow" },
    { id: "reply-in-chat", label: "Answer in chat", behavior: "deny" },
  ]);
  assert.deepEqual(several?.actions, [{ id: "reply-in-chat", label: "Answer in chat", behavior: "deny" }]);
});

test("leaves a request the form could not render as the tool card it already was", () => {
  assert.equal(questionPermission(toolPermission("Bash", { command: "pwd" })), null);
  assert.equal(questionPermission(toolPermission("AskUserQuestion", { questions: [] })), null);
  assert.equal(questionPermission(toolPermission("AskUserQuestion", { questions: [{ header: "Runtime" }] })), null);
});

test("keeps the headers the answers come back under distinct", () => {
  const card = questionPermission(
    toolPermission("AskUserQuestion", {
      questions: [
        { question: "First?", header: "Scope", options: [{ label: "A" }] },
        { question: "Second?", header: "Scope", options: [{ label: "B" }] },
      ],
    }),
  )!;

  assert.deepEqual(
    (card.input?.questions as Array<{ header: string }>).map((question) => question.header),
    ["Scope", "Scope (2)"],
  );
  assert.deepEqual(answersByQuestion({ answers: { Scope: "A", "Scope (2)": "B" } }, card), { "First?": "A", "Second?": "B" });
});

test("reads the answers back onto the questions Claude asked, by header or by question", () => {
  const card = questionPermission(
    toolPermission("AskUserQuestion", { questions: [{ question: "Which runtime?", header: "Runtime", options: [{ label: "Node" }] }] }),
  )!;

  assert.deepEqual(answersByQuestion({ answers: { Runtime: "Node, Bun" } }, card), { "Which runtime?": "Node, Bun" });
  assert.deepEqual(answersByQuestion({ answers: { "Which runtime?": "Deno" } }, card), { "Which runtime?": "Deno" });
  // Nothing that was not asked rides in on a response, and neither does an answer left blank.
  assert.deepEqual(answersByQuestion({ answers: { Elsewhere: "Yes", Runtime: "  " } }, card), {});
  assert.deepEqual(answersByQuestion(undefined, card), {});
});

test("gives a plan Paseo's own card and vocabulary", () => {
  const plan = planPermission(toolPermission("ExitPlanMode", { plan: "1. Implement\n2. Verify" }));

  assert.equal(plan?.kind, "plan");
  assert.equal(plan?.title, "Approve Claude's plan");
  assert.equal(plan?.metadata?.planText, "1. Implement\n2. Verify");
  assert.deepEqual(plan?.actions, [
    { id: "reject", label: "Reject", behavior: "deny", variant: "danger", intent: "dismiss" },
    { id: "implement", label: "Implement", behavior: "allow", variant: "primary", intent: "implement" },
  ]);
  assert.equal(planPermission(toolPermission("Bash", { command: "pwd" })), null);
});
