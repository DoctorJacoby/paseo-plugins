import assert from "node:assert/strict";
import test from "node:test";
import type { AgentSideConnection, RequestPermissionRequest, RequestPermissionResponse } from "@agentclientprotocol/sdk";
import { InteractionBridge } from "./interactions.ts";

function connectionWith(
  handler: (request: RequestPermissionRequest) => Promise<RequestPermissionResponse>,
): AgentSideConnection {
  return { requestPermission: handler } as AgentSideConnection;
}

function selected(optionId: string): RequestPermissionResponse {
  return { outcome: { outcome: "selected", optionId } };
}

test("correlates ordinary permissions and returns exact durable suggestions", async () => {
  const requests: RequestPermissionRequest[] = [];
  const suggestion = {
    type: "addRules",
    rules: [{ toolName: "Bash", ruleContent: "pnpm test" }],
    behavior: "allow",
    destination: "localSettings",
  };
  const bridge = new InteractionBridge(
    "session",
    "/work/repo",
    connectionWith(async (request) => {
      requests.push(request);
      return selected("allow-suggestion-0");
    }),
  );
  await bridge.handlePreToolUse({
    hook_event_name: "PreToolUse",
    session_id: "session",
    tool_use_id: "tool-1",
    tool_name: "Bash",
    tool_input: { command: "pnpm test", description: "Run tests" },
  });
  const response = await bridge.handlePermissionRequest({
    hook_event_name: "PermissionRequest",
    session_id: "session",
    tool_name: "Bash",
    tool_input: { command: "pnpm test", description: "Run tests" },
    permission_suggestions: [suggestion],
  });

  assert.equal(requests[0]?.toolCall.toolCallId, "tool-1");
  assert.equal(requests[0]?.options.some((option) => option.kind === "allow_once"), true);
  assert.deepEqual(response, {
    hookSpecificOutput: {
      hookEventName: "PermissionRequest",
      decision: { behavior: "allow", updatedPermissions: [suggestion] },
    },
  });
});

test("uses affirmative chooser actions for question answers", async () => {
  const requests: RequestPermissionRequest[] = [];
  const answers = ["answer-1", "answer-0", "answer-1", "done"];
  const bridge = new InteractionBridge(
    "session",
    "/work/repo",
    connectionWith(async (request) => {
      requests.push(request);
      return selected(answers.shift()!);
    }),
  );
  const questions = [
    {
      question: "Choose runtime",
      header: "Runtime",
      options: [{ label: "Node" }, { label: "Bun" }],
      multiSelect: false,
    },
    {
      question: "Choose checks",
      header: "Checks",
      options: [{ label: "Types" }, { label: "Tests" }],
      multiSelect: true,
    },
  ];
  const response = await bridge.handlePreToolUse({
    hook_event_name: "PreToolUse",
    session_id: "session",
    tool_use_id: "question-tool",
    tool_name: "AskUserQuestion",
    tool_input: { questions },
  });

  assert.ok(
    requests.every((request) =>
      request.options.every((option) => option.kind === (option.optionId === "reply-next" ? "reject_once" : "allow_once")),
    ),
  );
  assert.deepEqual(response, {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "allow",
      updatedInput: {
        questions,
        answers: { "Choose runtime": "Bun", "Choose checks": "Types, Tests" },
      },
    },
  });
});

test("falls back to a conversational answer and approves plans natively", async () => {
  const responses = [selected("answer-0"), selected("reply-next"), selected("answer-0"), selected("approve-plan")];
  const bridge = new InteractionBridge(
    "session",
    "/work/repo",
    connectionWith(async () => responses.shift()!),
  );
  const question = await bridge.handlePreToolUse({
    tool_name: "AskUserQuestion",
    tool_use_id: "question",
    tool_input: {
      questions: [
        { question: "Name?", options: [{ label: "Alice" }] },
        { question: "Notes?", options: [{ label: "None" }] },
        { question: "Proceed?", options: [{ label: "Yes" }] },
      ],
    },
  });
  assert.deepEqual(question, {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason:
        'The user chose to answer some questions in chat. Keep these completed answers: {"Name?":"Alice","Proceed?":"Yes"}. Ask only these deferred questions: ["Notes?"]. Restate the deferred questions conversationally in one message, then end this turn and wait for the user\'s response.',
    },
  });

  const input = { plan: "1. Implement\n2. Verify", allowedPrompts: [] };
  const plan = await bridge.handlePreToolUse({ tool_name: "ExitPlanMode", tool_use_id: "plan", tool_input: input });
  assert.deepEqual(plan, {
    hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "allow", updatedInput: input },
  });
});

test("renders question permission cards as readable text instead of raw JSON", async () => {
  const requests: RequestPermissionRequest[] = [];
  const bridge = new InteractionBridge(
    "session",
    "/work/repo",
    connectionWith(async (request) => {
      requests.push(request);
      return selected("answer-1");
    }),
  );
  const question = {
    question: "Choose runtime",
    header: "Runtime",
    options: [
      { label: "Node", description: "Use the established runtime" },
      { label: "Bun", description: "Use the faster alternative" },
    ],
    multiSelect: false,
  };

  await bridge.handlePreToolUse({
    hook_event_name: "PreToolUse",
    session_id: "session",
    tool_use_id: "question-tool",
    tool_name: "AskUserQuestion",
    tool_input: { questions: [question] },
  });

  assert.deepEqual(requests[0]?.toolCall.rawInput, question);
  assert.deepEqual(requests[0]?.toolCall.content, [
    {
      type: "content",
      content: {
        type: "text",
        text: "Choose runtime\n\n- Node — Use the established runtime\n- Bun — Use the faster alternative",
      },
    },
  ]);
});

test("cancels outstanding hook waits when the turn ends", async () => {
  let requested = false;
  const bridge = new InteractionBridge(
    "session",
    "/work/repo",
    connectionWith(async () => {
      requested = true;
      return new Promise<RequestPermissionResponse>(() => undefined);
    }),
  );
  const pending = bridge.handlePermissionRequest({ tool_name: "Bash", tool_input: { command: "pwd" } });
  await waitFor(() => requested);
  bridge.cancelPending();
  const response = await pending;
  assert.deepEqual(response, {
    hookSpecificOutput: {
      hookEventName: "PermissionRequest",
      decision: { behavior: "deny", message: "The permission request was cancelled.", interrupt: false },
    },
  });
});

test("answers the permission pipeline from the question card the killed PreToolUse hook left on screen", async () => {
  const requests: RequestPermissionRequest[] = [];
  let answer: ((response: RequestPermissionResponse) => void) | null = null;
  const bridge = new InteractionBridge(
    "session",
    "/work/repo",
    connectionWith(async (request) => {
      requests.push(request);
      return new Promise<RequestPermissionResponse>((resolve) => {
        answer = resolve;
      });
    }),
  );
  const questions = [{ question: "Choose runtime", options: [{ label: "Node" }, { label: "Bun" }], multiSelect: false }];
  const preTool = bridge.handlePreToolUse({
    tool_name: "AskUserQuestion",
    tool_use_id: "question-tool",
    tool_input: { questions },
  });
  await waitFor(() => requests.length > 0);

  // Claude killed that hook at its timeout and fell through to its permission pipeline for the same call.
  const permission = bridge.handlePermissionRequest({ tool_name: "AskUserQuestion", tool_input: { questions } });
  await waitFor(() => answer !== null);
  answer!(selected("answer-1"));

  assert.deepEqual(await permission, {
    hookSpecificOutput: {
      hookEventName: "PermissionRequest",
      decision: { behavior: "allow", updatedInput: { questions, answers: { "Choose runtime": "Bun" } } },
    },
  });
  assert.deepEqual(await preTool, {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "allow",
      updatedInput: { questions, answers: { "Choose runtime": "Bun" } },
    },
  });
  assert.equal(requests.length, 1);
  assert.equal(requests[0]?.toolCall.toolCallId, "question-tool-question-0-0");
});

test("renders a question the permission pipeline asks about on its own", async () => {
  const requests: RequestPermissionRequest[] = [];
  const bridge = new InteractionBridge(
    "session",
    "/work/repo",
    connectionWith(async (request) => {
      requests.push(request);
      return selected("answer-0");
    }),
  );
  const questions = [{ question: "Proceed?", options: [{ label: "Yes" }] }];
  const response = await bridge.handlePermissionRequest({ tool_name: "AskUserQuestion", tool_input: { questions } });

  assert.deepEqual(requests[0]?.toolCall.rawInput, questions[0]);
  assert.deepEqual(response, {
    hookSpecificOutput: {
      hookEventName: "PermissionRequest",
      decision: { behavior: "allow", updatedInput: { questions, answers: { "Proceed?": "Yes" } } },
    },
  });
});

test("declines consent cards answered with a behaviour and no action id", async () => {
  const requests: RequestPermissionRequest[] = [];
  // `paseo permit` sends a bare behaviour, and @getpaseo/plugin 0.8.0 takes the first option whose kind matches it.
  const answerBare = (behavior: "allow" | "deny") =>
    connectionWith(async (request) => {
      requests.push(request);
      const option = request.options.find((candidate) => (candidate.kind.startsWith("allow") ? "allow" : "deny") === behavior);
      return option ? selected(option.optionId) : { outcome: { outcome: "cancelled" } };
    });

  for (const behavior of ["allow", "deny"] as const) {
    const bridge = new InteractionBridge("session", "/work/repo", answerBare(behavior));
    assert.equal(await bridge.requestWorkspaceTrust(), false);
    assert.equal(await bridge.requestBypassPermissions(), false);
  }
  assert.equal(requests.length, 4);
});

async function waitFor(predicate: () => boolean): Promise<void> {
  while (!predicate()) await new Promise((resolve) => setImmediate(resolve));
}

test("keeps the tools waiting for a permission bounded, so a session working between prompts does not grow one", async () => {
  const requests: RequestPermissionRequest[] = [];
  const bridge = new InteractionBridge(
    "session",
    "/work/repo",
    connectionWith(async (request) => {
      requests.push(request);
      return selected("allow-once");
    }),
  );
  // Claude runs tools that raise no card, and only a prompt empties what they leave behind.
  // A session woken by a task notification is never prompted, so the count here is the run, not the turn.
  for (let index = 0; index < 150; index += 1) {
    await bridge.handlePreToolUse({
      hook_event_name: "PreToolUse",
      session_id: "session",
      tool_use_id: `tool-${index}`,
      tool_name: "Bash",
      tool_input: { command: `echo ${index}` },
    });
  }

  // The newest is still there to correlate with, which is the only one a PermissionRequest ever asks for.
  await bridge.handlePermissionRequest({
    hook_event_name: "PermissionRequest",
    session_id: "session",
    tool_name: "Bash",
    tool_input: { command: "echo 149" },
  });
  assert.equal(requests[0]?.toolCall.toolCallId, "tool-149");

  // The oldest has been let go of rather than held for the life of the process.
  await bridge.handlePermissionRequest({
    hook_event_name: "PermissionRequest",
    session_id: "session",
    tool_name: "Bash",
    tool_input: { command: "echo 0" },
  });
  assert.notEqual(requests[1]?.toolCall.toolCallId, "tool-0");
  assert.match(requests[1]!.toolCall.toolCallId, /^permission-/);
});
