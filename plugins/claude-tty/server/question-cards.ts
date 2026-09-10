import type { ProviderPermissionAction, ProviderPermissionRequest, ProviderPermissionResponse } from "@getpaseo/plugin/server/provider";

/** The protocol's own JSON record, taken off the permission types rather than from a dependency of its own. */
type JsonRecord = NonNullable<ProviderPermissionRequest["input"]>;

/**
 * Claude's own names for the two tools that ask a person rather than the machine, mirrored by
 * `apps/claude-tty-acp/src/interactions.ts`, which sends them out as the permission's name, and by
 * `question-card.ts` beside it, which owns the option ids. Keep the copies in step: a name that
 * drifts leaves the request as the plain tool card the ACP bridge builds by default.
 */
export const QUESTION_TOOL = "AskUserQuestion";
export const PLAN_TOOL = "ExitPlanMode";
export const SUBMIT_OPTION_ID = "submit";
export const IMPLEMENT_OPTION_ID = "implement";
export const REPLY_IN_CHAT_OPTION_ID = "reply-in-chat";

type Question = {
  question: string;
  header: string;
  options: Array<{ label: string; description?: string }>;
  multiSelect: boolean;
};

/**
 * Paseo's question form is strict about the shape it will render — every question needs a string
 * `question` and a string `header`, every option a string `label` — and answers a request it cannot
 * parse with a card that draws nothing at all. So the questions are rebuilt here rather than passed
 * on, and a request with nothing left to ask keeps the tool card it already had.
 */
export function questionPermission(request: ProviderPermissionRequest): ProviderPermissionRequest | null {
  if (request.name !== QUESTION_TOOL) return null;
  const questions = readQuestions(request.input);
  if (questions.length === 0) return null;
  return {
    ...request,
    kind: "question",
    ...questionSummary(questions),
    input: {
      ...(request.input ?? {}),
      questions: questions.map((question) => ({
        question: question.question,
        header: question.header,
        multiSelect: question.multiSelect,
        // Claude's schema leaves "Other" to the host, and this is what Paseo's form calls that box.
        allowOther: true,
        options: question.options,
      })),
    },
    // The form sends every answer at once and consults none of these; they are what the clients
    // without one — a terminal, a notification — have to answer from, so they only stand alone
    // while a single question is on the card.
    actions: [
      ...(questions.length === 1 ? answerActions(questions[0]!) : []),
      { id: REPLY_IN_CHAT_OPTION_ID, label: "Answer in chat", behavior: "deny" },
    ],
  };
}

/**
 * Paseo renders a plan of its own accord, from `metadata.planText` before the raw input, and offers
 * its own vocabulary for approving one. There is no `implement_resume` beside it: the permission
 * mode is an argument the adapter launches Claude with, so this session cannot return to the mode
 * planning interrupted.
 */
export function planPermission(request: ProviderPermissionRequest): ProviderPermissionRequest | null {
  if (request.name !== PLAN_TOOL) return null;
  // ExitPlanMode's schema is open and names none of these, so all three are read the way the card did before.
  const plan = readString(request.input?.plan) ?? readString(request.input?.planContent) ?? readString(request.input?.plan_file_path);
  return {
    ...request,
    kind: "plan",
    title: "Approve Claude's plan",
    ...(plan ? { metadata: { ...(request.metadata ?? {}), planText: plan } } : {}),
    actions: [
      { id: "reject", label: "Reject", behavior: "deny", variant: "danger", intent: "dismiss" },
      { id: IMPLEMENT_OPTION_ID, label: "Implement", behavior: "allow", variant: "primary", intent: "implement" },
    ],
  };
}

/** The one line a terminal, a push notification or a list of pending requests has room for. */
export function questionSummary(questions: Question[]): { title: string; description: string } {
  const first = questions[0]!;
  const more = questions.length - 1;
  return {
    title: more > 0 ? `${first.question} (+${more} more)` : first.question,
    description: questions.map((question) => `${question.header}: ${question.options.map((option) => option.label).join(" / ")}`).join(" · "),
  };
}

/**
 * The answers the form collects come back keyed by header, which is what it shows on the tab; Claude
 * expects the question itself. Only questions that were asked are carried over, so an answer to
 * something else cannot ride in on a response.
 */
export function answersByQuestion(
  updatedInput: Extract<ProviderPermissionResponse, { behavior: "allow" }>["updatedInput"],
  request: ProviderPermissionRequest,
): Record<string, string> {
  const answers = readRecord(updatedInput?.answers);
  if (!answers) return {};
  const byQuestion: Record<string, string> = {};
  for (const question of readQuestions(request.input)) {
    const answer = readString(answers[question.question]) ?? readString(answers[question.header]);
    if (answer) byQuestion[question.question] = answer;
  }
  return byQuestion;
}

function answerActions(question: Question): ProviderPermissionAction[] {
  return question.options.map((option, index) => ({
    id: `answer-0-${index}`,
    label: option.label,
    behavior: "allow" as const,
  }));
}

function readQuestions(input: ProviderPermissionRequest["input"]): Question[] {
  const questions = Array.isArray(input?.questions) ? input.questions : [];
  // The form keys its answers by header, so two questions sharing one would come back as a single
  // answer for both. Reading the questions back out of a card that has already been through here
  // finds no duplicates left and leaves the headers alone.
  const headers = new Set<string>();
  return questions.flatMap((value) => {
    const question = readRecord(value);
    const text = readString(question?.question);
    if (!question || !text) return [];
    const options = (Array.isArray(question.options) ? question.options : []).flatMap((value) => {
      const option = readRecord(value);
      const label = readString(option?.label);
      if (!option || !label) return [];
      // Paseo's form has no surface for a preview, and a description under the label is the one
      // place an option can say more, so a preview that would otherwise be dropped goes there.
      const description = [readString(option.description), readString(option.preview)].filter((part) => part !== null).join("\n\n");
      return [{ label, ...(description ? { description } : {}) }];
    });
    return [{ question: text, header: uniqueHeader(readString(question.header) ?? text, headers), options, multiSelect: question.multiSelect === true }];
  });
}

function uniqueHeader(header: string, taken: Set<string>): string {
  let candidate = header;
  for (let suffix = 2; taken.has(candidate); suffix += 1) candidate = `${header} (${suffix})`;
  taken.add(candidate);
  return candidate;
}

function readRecord(value: unknown): JsonRecord | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as JsonRecord) : null;
}

function readString(value: unknown): string | null {
  const text = typeof value === "string" ? value.trim() : "";
  return text.length > 0 ? text : null;
}
