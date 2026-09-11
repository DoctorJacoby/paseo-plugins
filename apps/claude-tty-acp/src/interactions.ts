import { randomUUID } from "node:crypto";
import path from "node:path";
import type { AgentSideConnection, PermissionOption, RequestPermissionResponse, ToolCallUpdate, ToolKind } from "@agentclientprotocol/sdk";
import { createDeferred, type Deferred } from "./deferred.ts";
import type { HookPayload, HookResponse } from "./hook-server.ts";
import { questionText } from "./question-text.ts";

type PermissionSuggestion = Record<string, unknown>;

type PendingTool = {
  id: string;
  name: string;
  input: Record<string, unknown>;
};

// An entry waits only for the PermissionRequest that follows its PreToolUse a moment later, and every entry is dropped at the start of a prompt.
// Claude works between prompts too — the turn a task notification wakes it for, the agents it launches there — and none of that is a prompt, so a session left to work holds one tool input per call it makes until its process stops.
const MAX_PENDING_TOOLS = 100;

type PermissionChoice = {
  response: RequestPermissionResponse;
  suggestion?: PermissionSuggestion;
};

type Consent = {
  id: string;
  title: string;
  details: Record<string, unknown>;
  accept: { optionId: string; name: string };
  decline: { optionId: string; name: string };
};

type InteractionOutcome =
  | { decision: "allow"; input: Record<string, unknown> }
  | { decision: "deny"; reason: string };

const TOOL_KINDS: Record<string, ToolKind> = {
  Bash: "execute",
  Edit: "edit",
  Glob: "search",
  Grep: "search",
  MultiEdit: "edit",
  NotebookEdit: "edit",
  Read: "read",
  WebFetch: "fetch",
  WebSearch: "search",
  Write: "edit",
};

export class InteractionBridge {
  private readonly sessionId: string;
  private readonly cwd: string;
  private readonly connection: AgentSideConnection;
  private readonly pendingTools: PendingTool[] = [];
  private readonly pendingRequests = new Set<Deferred<RequestPermissionResponse>>();
  private readonly liveInteractions = new Map<string, Promise<InteractionOutcome>>();

  constructor(sessionId: string, cwd: string, connection: AgentSideConnection) {
    this.sessionId = sessionId;
    this.cwd = cwd;
    this.connection = connection;
  }

  /** Something is waiting on a person: a card is open in Paseo and Claude is blocked on the hook behind it. */
  get pending(): boolean {
    return this.pendingRequests.size > 0;
  }

  beginTurn(): void {
    this.pendingTools.length = 0;
    this.cancelPending();
  }

  cancelPending(): void {
    for (const pending of this.pendingRequests) pending.resolve({ outcome: { outcome: "cancelled" } });
    this.pendingRequests.clear();
  }

  requestWorkspaceTrust(): Promise<boolean> {
    return this.requestConsent({
      id: "workspace-trust",
      title: "Is this a project you created or one you trust?",
      details: { effect: "Claude Code will remember this workspace as trusted." },
      accept: { optionId: "trust-workspace", name: "Yes, trust this folder" },
      decline: { optionId: "deny-workspace", name: "No, exit" },
    });
  }

  requestBypassPermissions(): Promise<boolean> {
    return this.requestConsent({
      id: "bypass-permissions",
      title: "Run Claude Code without asking permission for anything?",
      details: {
        warning: "In Bypass Permissions mode Claude Code runs every command, including destructive ones, without asking.",
        effect: "Claude Code will remember this answer for every session on this host, in every workspace.",
      },
      accept: { optionId: "accept-bypass", name: "Yes, I accept" },
      decline: { optionId: "deny-bypass", name: "No, exit" },
    });
  }

  async handlePreToolUse(payload: HookPayload): Promise<HookResponse> {
    const name = stringValue(payload.tool_name) || "Tool";
    const input = objectValue(payload.tool_input) || {};
    const toolUseId = stringValue(payload.tool_use_id) || `tool-${randomUUID()}`;
    if (this.pendingTools.length >= MAX_PENDING_TOOLS) this.pendingTools.shift();
    this.pendingTools.push({ id: toolUseId, name, input });
    const interaction = this.interactionFor(name, input, toolUseId);
    if (interaction) return preToolResponse(await interaction);
    return {};
  }

  async handlePermissionRequest(payload: HookPayload): Promise<HookResponse> {
    const name = stringValue(payload.tool_name) || "Tool";
    const input = objectValue(payload.tool_input) || {};
    const pending = this.takePendingTool(name, input);
    const toolCallId = pending?.id || `permission-${randomUUID()}`;
    const interaction = this.interactionFor(name, input, toolCallId);
    if (interaction) return permissionResponse(await interaction);
    const suggestions = Array.isArray(payload.permission_suggestions)
      ? payload.permission_suggestions.filter((value): value is PermissionSuggestion => objectValue(value) !== null)
      : [];
    const suggestionByOption = new Map<string, PermissionSuggestion>();
    const options: PermissionOption[] = [{ optionId: "allow-once", name: "Allow once", kind: "allow_once" }];
    for (let index = 0; index < suggestions.length; index += 1) {
      const optionId = `allow-suggestion-${index}`;
      suggestionByOption.set(optionId, suggestions[index]!);
      options.push({ optionId, name: suggestionLabel(suggestions[index]!), kind: "allow_always" });
    }
    options.push({ optionId: "deny", name: "Deny", kind: "reject_once" });
    const response = await this.request({
      toolCall: toolCall(toolCallId, name, input, this.cwd),
      options,
    });
    const choice: PermissionChoice = {
      response,
      ...(response.outcome.outcome === "selected" ? { suggestion: suggestionByOption.get(response.outcome.optionId) } : {}),
    };
    return permissionHookResponse(choice);
  }

  // Claude skips its permission pipeline only while the PreToolUse hook that renders these answers in time.
  // A hook that died leaves the pipeline to ask instead, so the same interaction serves both events: it reuses the card already on screen, or renders one here.
  // Rendering the tool again would show it as raw JSON, and that card's Allow leaves Claude waiting at its own dialog inside the PTY.
  private interactionFor(name: string, input: Record<string, unknown>, toolUseId: string): Promise<InteractionOutcome> | null {
    if (name === "AskUserQuestion") return this.interaction(name, input, () => this.handleQuestions(toolUseId, input));
    if (name === "ExitPlanMode") return this.interaction(name, input, () => this.handlePlanApproval(toolUseId, input));
    return null;
  }

  private interaction(name: string, input: Record<string, unknown>, start: () => Promise<InteractionOutcome>): Promise<InteractionOutcome> {
    const key = `${name}:${JSON.stringify(input)}`;
    const live = this.liveInteractions.get(key);
    if (live) return live;
    const pending = start().finally(() => this.liveInteractions.delete(key));
    this.liveInteractions.set(key, pending);
    return pending;
  }

  private async handleQuestions(toolUseId: string, input: Record<string, unknown>): Promise<InteractionOutcome> {
    const questions = Array.isArray(input.questions) ? input.questions : [];
    const answers: Record<string, string> = {};
    const deferredQuestions: string[] = [];
    for (let index = 0; index < questions.length; index += 1) {
      const question = objectValue(questions[index]);
      const text = stringValue(question?.question);
      if (!question || !text) continue;
      const selected = new Set<string>();
      let round = 0;
      while (true) {
        const choices = Array.isArray(question.options) ? question.options : [];
        const options: PermissionOption[] = choices.flatMap((value, optionIndex) => {
          const option = objectValue(value);
          const label = stringValue(option?.label);
          if (!label) return [];
          return [questionOption(`answer-${optionIndex}`, `${selected.has(label) ? "✓ " : ""}${label}`)];
        });
        if (question.multiSelect === true) options.push(questionOption("done", "Done"));
        options.push(questionOption("reply-next", "Answer this question in chat"));
        const response = await this.request({
          toolCall: {
            toolCallId: `${toolUseId}-question-${index}-${round}`,
            title: stringValue(question.header) || text,
            kind: "other",
            status: "pending",
            rawInput: question,
            content: [{ type: "content", content: { type: "text", text: questionText(question, text) } }],
          },
          options,
        });
        if (response.outcome.outcome === "cancelled") {
          const remainingQuestions = questions.slice(index).flatMap((value) => {
            const remaining = objectValue(value);
            const remainingText = stringValue(remaining?.question);
            return remainingText ? [remainingText] : [];
          });
          return conversationalQuestionFallback(answers, [...deferredQuestions, ...remainingQuestions]);
        }
        if (response.outcome.optionId === "reply-next") {
          deferredQuestions.push(text);
          break;
        }
        if (response.outcome.optionId === "done") {
          answers[text] = [...selected].join(", ");
          break;
        }
        const optionIndex = Number.parseInt(response.outcome.optionId.replace("answer-", ""), 10);
        const chosen = objectValue(choices[optionIndex]);
        const label = stringValue(chosen?.label);
        if (!label) return conversationalQuestionFallback();
        if (question.multiSelect !== true) {
          answers[text] = label;
          break;
        }
        if (selected.has(label)) selected.delete(label);
        else selected.add(label);
        round += 1;
      }
    }
    if (deferredQuestions.length > 0) return conversationalQuestionFallback(answers, deferredQuestions);
    return { decision: "allow", input: { ...input, answers } };
  }

  private async handlePlanApproval(toolUseId: string, input: Record<string, unknown>): Promise<InteractionOutcome> {
    const plan = stringValue(input.plan) || stringValue(input.planContent) || stringValue(input.plan_file_path);
    const response = await this.request({
      toolCall: {
        toolCallId: `${toolUseId}-approval`,
        title: "Approve Claude's plan",
        kind: "switch_mode",
        status: "pending",
        rawInput: input,
        ...(plan ? { content: [{ type: "content", content: { type: "text", text: plan } }] } : {}),
      },
      options: [
        { optionId: "approve-plan", name: "Approve plan", kind: "allow_once" },
        { optionId: "deny-plan", name: "Keep planning", kind: "reject_once" },
      ],
    });
    if (response.outcome.outcome === "selected" && response.outcome.optionId === "approve-plan") return { decision: "allow", input };
    return { decision: "deny", reason: "The user did not approve leaving plan mode." };
  }

  /**
   * A card for a decision Claude asks for before a session runs, and keeps once it is answered.
   * Both options are declining ones because the answer outlives the session that raised it, and Paseo's automatic permission modes accept allow options without showing anybody a card.
   * The decline comes first because an answer carrying no action id, which is what `paseo permit deny` sends, takes the first option of its behaviour, and here that is either option.
   */
  private async requestConsent(consent: Consent): Promise<boolean> {
    const response = await this.request({
      toolCall: {
        toolCallId: `${consent.id}-${randomUUID()}`,
        title: consent.title,
        kind: "other",
        status: "pending",
        rawInput: { workspace: this.cwd, ...consent.details },
        locations: [{ path: this.cwd }],
      },
      options: [
        { ...consent.decline, kind: "reject_once" },
        { ...consent.accept, kind: "reject_once" },
      ],
    });
    return response.outcome.outcome === "selected" && response.outcome.optionId === consent.accept.optionId;
  }

  private request(params: { toolCall: ToolCallUpdate; options: PermissionOption[] }): Promise<RequestPermissionResponse> {
    const cancellation = createDeferred<RequestPermissionResponse>();
    this.pendingRequests.add(cancellation);
    return Promise.race([
      this.connection.requestPermission({ sessionId: this.sessionId, ...params }),
      cancellation.promise,
    ]).finally(() => this.pendingRequests.delete(cancellation));
  }

  private takePendingTool(name: string, input: Record<string, unknown>): PendingTool | null {
    const signature = JSON.stringify(input);
    const index = this.pendingTools.findLastIndex((tool) => tool.name === name && JSON.stringify(tool.input) === signature);
    if (index < 0) return null;
    return this.pendingTools.splice(index, 1)[0] || null;
  }
}

function permissionHookResponse(choice: PermissionChoice): HookResponse {
  const outcome = choice.response.outcome;
  if (outcome.outcome === "cancelled" || outcome.optionId === "deny") {
    return {
      hookSpecificOutput: {
        hookEventName: "PermissionRequest",
        decision: { behavior: "deny", message: outcome.outcome === "cancelled" ? "The permission request was cancelled." : "The user denied this action.", interrupt: false },
      },
    };
  }
  return {
    hookSpecificOutput: {
      hookEventName: "PermissionRequest",
      decision: { behavior: "allow", ...(choice.suggestion ? { updatedPermissions: [choice.suggestion] } : {}) },
    },
  };
}

function preToolResponse(outcome: InteractionOutcome): HookResponse {
  if (outcome.decision === "deny") {
    return { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: outcome.reason } };
  }
  return { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "allow", updatedInput: outcome.input } };
}

// The answers have to ride in as updatedInput here too, because Claude reads a bare allow for a tool that asks the user something as permission to run its own dialog, which in this PTY nobody can answer.
function permissionResponse(outcome: InteractionOutcome): HookResponse {
  if (outcome.decision === "deny") {
    return {
      hookSpecificOutput: {
        hookEventName: "PermissionRequest",
        decision: { behavior: "deny", message: outcome.reason, interrupt: false },
      },
    };
  }
  return {
    hookSpecificOutput: {
      hookEventName: "PermissionRequest",
      decision: { behavior: "allow", updatedInput: outcome.input },
    },
  };
}

function conversationalQuestionFallback(answers: Record<string, string> = {}, deferredQuestions: string[] = []): InteractionOutcome {
  const completed = Object.keys(answers).length > 0 ? ` Keep these completed answers: ${JSON.stringify(answers)}.` : "";
  const deferred = deferredQuestions.length > 0 ? ` Ask only these deferred questions: ${JSON.stringify(deferredQuestions)}.` : "";
  return {
    decision: "deny",
    reason: `The user chose to answer some questions in chat.${completed}${deferred} Restate the deferred questions conversationally in one message, then end this turn and wait for the user's response.`,
  };
}

function questionOption(optionId: string, name: string): PermissionOption {
  return { optionId, name, kind: optionId === "reply-next" ? "reject_once" : "allow_once" };
}

function toolCall(id: string, name: string, input: Record<string, unknown>, cwd: string): ToolCallUpdate {
  const candidatePath = stringValue(input.file_path) || stringValue(input.path);
  const resolvedPath = candidatePath ? (path.isAbsolute(candidatePath) ? candidatePath : path.resolve(cwd, candidatePath)) : null;
  return {
    toolCallId: id,
    title: toolTitle(name, input),
    kind: TOOL_KINDS[name] || "other",
    status: "pending",
    rawInput: input,
    ...(resolvedPath ? { locations: [{ path: resolvedPath }] } : {}),
  };
}

function toolTitle(name: string, input: Record<string, unknown>): string {
  const detail = stringValue(input.description) || stringValue(input.command)?.split("\n")[0] || stringValue(input.file_path) || stringValue(input.query);
  return detail ? `${name}: ${detail}` : name;
}

function suggestionLabel(suggestion: PermissionSuggestion): string {
  const destination = stringValue(suggestion.destination);
  const rules = Array.isArray(suggestion.rules) ? suggestion.rules : [];
  const firstRule = objectValue(rules[0]);
  const toolName = stringValue(firstRule?.toolName);
  const content = stringValue(firstRule?.ruleContent);
  const scope = destination === "userSettings" ? "globally" : destination === "projectSettings" ? "for this project" : "locally";
  return toolName ? `Always allow ${toolName}${content ? ` (${content})` : ""} ${scope}` : `Apply Claude's permission suggestion ${scope}`;
}

function objectValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}
