import { randomUUID } from "node:crypto";
import type { AgentSideConnection, PermissionOption } from "@agentclientprotocol/sdk";
import { choiceSelected, type DialogReading, dialogTitle, readDialog, sameDialog } from "./dialog-screen.ts";
import type { InteractionBridge } from "./interactions.ts";
import { writeLog } from "./log.ts";
import { sendCardWithdrawn, sendNotice } from "./vendor-updates.ts";

/** How often Claude's state file is read while a session is up. It is a few hundred bytes and a stat. */
export const DIALOG_POLL_MS = 400;
/** How long each key gets to move the marker, and how long the whole of that may take. */
export const DIALOG_ANSWER_KEY_MS = 200;
export const DIALOG_ANSWER_TIMEOUT_MS = 3_000;
/** How long Claude is given to stop waiting once its question has been answered or dismissed. */
export const DIALOG_SETTLE_MS = 1_500;
const SETTLE_POLL_MS = 25;

/**
 * How `plugins/claude-tty/server/dialog-cards.ts` tells this card from every other permission: a key in
 * the input that only this writes. Mirrored there as a string, because the plugin runs in the daemon and
 * cannot import this. It is the input rather than the tool's name because the version of ACP this SDK
 * speaks has no field for a name -- `ToolCallUpdate` carries a title and nothing else that travels --
 * and the title here is the question, which is what a person should be reading.
 */
export const DIALOG_INPUT_MARKER = "claudeDialog";

export const DISMISS_OPTION_ID = "dialog-dismiss";
export const CHOICE_OPTION_PREFIX = "dialog-choice-";

/** The menu contract `ClaudeRuntime.answerStartupMenu` already answers Claude's startup dialogs with. */
export type DialogMenu = {
  onScreen: (screen: string) => boolean;
  selected: (screen: string) => boolean;
  keyDelayMs: number;
  timeoutMs: number;
  exited: string;
};

export type DialogWatcherOptions = {
  sessionId: string;
  connection: AgentSideConnection;
  interactions: InteractionBridge;
  /** What Claude's own state file says has the keyboard, or null when nothing has. */
  waitingFor: () => Promise<string | null>;
  screen: () => string;
  /** The key that closes a dialog, straight into the PTY. */
  escape: () => void;
  answerMenu: (menu: DialogMenu) => Promise<"confirmed" | "gone" | "stuck">;
  /**
   * Whether the screen is showing one of the dialogs the adapter answers itself -- workspace trust,
   * the bypass disclaimer, the resume question. Those are answered on the startup path and must not
   * be carded on the way past.
   */
  answeredByStartup: (screen: string) => boolean;
  pollIntervalMs?: number;
  answerKeyMs?: number;
  answerTimeoutMs?: number;
  settleMs?: number;
};

type PendingCard = {
  id: string;
  dialog: DialogReading;
  withdraw: () => void;
};

/**
 * Claude's own dialogs, as cards in Paseo.
 *
 * Claude asks a session two kinds of question. The ones it asks through a hook -- a permission, an
 * `AskUserQuestion`, a plan -- `interactions.ts` already answers, and they are not this. The rest it
 * draws in its terminal and waits on: the nudges (a plugin it suggests, an LSP it noticed, an effort
 * level it would rather use), the setup questions, the callouts. Nothing reaches the PTY from outside
 * this process, so before this those could only ever be escaped away -- and until they were, every
 * prompt sent to that session failed, because the keys that would have sent it would have answered the
 * question instead.
 *
 * So the state file is polled for as long as the session's process is up, and a dialog that is not one
 * of the adapter's own becomes a card with a button per row and Dismiss. Every one of them is a
 * declining option: Paseo's automatic permission modes accept an allow option without showing anybody
 * anything, and a question Claude is holding the keyboard for is exactly the thing that must not be
 * answered by a machine. Answering moves the marker and presses Enter, the way the startup dialogs are
 * answered, and then reads Claude's state back to see that the question really did go.
 *
 * Every transition into a dialog is logged with the screen it was on, because what Claude actually puts
 * up here is a list that grows, and the log is how the next dialog gets parsed properly.
 */
export class DialogWatcher {
  private readonly options: DialogWatcherOptions;
  private readonly pollIntervalMs: number;
  private readonly answerKeyMs: number;
  private readonly answerTimeoutMs: number;
  private readonly settleMs: number;
  private timer: NodeJS.Timeout | null = null;
  private ticking = false;
  private pending: PendingCard | null = null;
  /** This waiting episode has had its card; a dialog is asked about once rather than once per poll. */
  private carded = false;
  /** The last dialog seen on screen, which is what the notice for a dismissed one is written from. */
  private lastSeen: DialogReading | null = null;

  constructor(options: DialogWatcherOptions) {
    this.options = options;
    this.pollIntervalMs = options.pollIntervalMs ?? DIALOG_POLL_MS;
    this.answerKeyMs = options.answerKeyMs ?? DIALOG_ANSWER_KEY_MS;
    this.answerTimeoutMs = options.answerTimeoutMs ?? DIALOG_ANSWER_TIMEOUT_MS;
    this.settleMs = options.settleMs ?? DIALOG_SETTLE_MS;
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick(), this.pollIntervalMs);
    this.timer.unref();
  }

  /** Stops watching and takes down whatever card is up: the process behind it is going or gone. */
  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.carded = false;
    this.lastSeen = null;
    const pending = this.pending;
    this.pending = null;
    pending?.withdraw();
    if (pending) void sendCardWithdrawn(this.options.connection, this.options.sessionId, pending.id);
  }

  /**
   * The prompt path got the keyboard back by closing a question. The card for it is taken down, and the
   * timeline says which question was closed to deliver the message -- otherwise the answer Claude was
   * waiting for simply disappears, and the session looks like it lost a nudge for no reason.
   */
  async dismissedForPrompt(waitingFor: string): Promise<void> {
    const dialog = this.pending?.dialog ?? this.lastSeen;
    await this.withdraw("a prompt arrived and the question was closed to deliver it");
    this.carded = false;
    this.lastSeen = null;
    await sendNotice(this.options.connection, this.options.sessionId, {
      id: `dialog-dismissed-${randomUUID()}`,
      severity: "warning",
      title: dialog ? `Dismissed Claude's question: ${dialogTitle(dialog)}` : `Dismissed what Claude had open (${waitingFor})`,
      description: [
        "Your message needed the keyboard, and Claude was holding it for a question of its own, so the question was closed unanswered.",
        dialog?.text,
      ]
        .filter((part): part is string => typeof part === "string" && part !== "")
        .join("\n\n"),
    });
  }

  private async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      const waitingFor = await this.options.waitingFor();
      if (waitingFor === null) {
        this.carded = false;
        this.lastSeen = null;
        if (this.pending) await this.withdraw("Claude closed the question itself");
        return;
      }
      if (this.pending || this.carded) return;
      // A hook is what Claude is waiting on, and the card for it is already up: `interactions.ts` owns
      // that answer, and a second card for the same wait would be answering over it.
      if (this.options.interactions.pending) return;
      const screen = this.options.screen();
      if (this.options.answeredByStartup(screen)) return;
      const dialog = readDialog(screen);
      if (!dialog) return;
      this.lastSeen = dialog;
      void this.raise(waitingFor, dialog);
    } catch (error) {
      writeLog({ level: "debug", message: "Could not read Claude's dialog state", sessionId: this.options.sessionId, error: errorMessage(error) });
    } finally {
      this.ticking = false;
    }
  }

  private async raise(waitingFor: string, dialog: DialogReading): Promise<void> {
    const id = `dialog-${randomUUID()}`;
    const request = this.options.interactions.openRequest({
      toolCall: {
        toolCallId: id,
        title: dialogTitle(dialog),
        kind: "other",
        status: "pending",
        rawInput: {
          [DIALOG_INPUT_MARKER]: true,
          waitingFor,
          question: dialog.question,
          choices: dialog.choices.map((choice) => choice.label),
          // The dialog as drawn, so a card built from a reading that found no rows can still be read.
          terminal: dialog.text,
        },
      },
      options: dialogOptions(dialog),
    });
    this.pending = { id, dialog, withdraw: request.withdraw };
    this.carded = true;
    writeLog({
      level: "info",
      message: "Claude opened a question of its own, and Paseo was asked",
      sessionId: this.options.sessionId,
      waitingFor,
      question: dialog.question,
      choices: dialog.choices.map((choice) => choice.label),
      // The whole screen, because the point of this line is the dialogs nobody has parsed yet.
      screen: dialog.text,
    });
    const response = await request.response;
    if (this.pending?.id !== id) return;
    this.pending = null;
    if (response.outcome.outcome === "cancelled") {
      // Not this class's doing -- a turn ended, or a prompt started, and `cancelPending` let go of every
      // card at once. The question is still up, so the next tick asks again rather than leaving a
      // session holding a dialog nobody can see.
      this.carded = false;
      return;
    }
    await this.answer(dialog, response.outcome.optionId);
  }

  private async answer(dialog: DialogReading, optionId: string): Promise<void> {
    if (optionId === DISMISS_OPTION_ID) {
      await this.escape("dismissed in Paseo");
      return;
    }
    const choice = dialog.choices[Number(optionId.slice(CHOICE_OPTION_PREFIX.length))];
    if (!choice) {
      await this.escape(`answered in Paseo with an option this session has no row for (${optionId})`);
      return;
    }
    let outcome: "confirmed" | "gone" | "stuck";
    try {
      outcome = await this.options.answerMenu({
        onScreen: (screen) => sameDialog(readDialog(screen), dialog),
        selected: (screen) => choiceSelected(screen, choice.label),
        keyDelayMs: this.answerKeyMs,
        timeoutMs: this.answerTimeoutMs,
        exited: "Claude exited before its question could be answered",
      });
    } catch (error) {
      writeLog({ level: "warn", message: "Claude stopped before its question could be answered", sessionId: this.options.sessionId, choice: choice.label, error: errorMessage(error) });
      return;
    }
    if (outcome === "gone") {
      writeLog({ level: "warn", message: "Claude's question was answered before the card's answer reached it", sessionId: this.options.sessionId, choice: choice.label });
      return;
    }
    if (outcome === "stuck") {
      // The marker would not go to the row, so the choice cannot be made. Closing the question is worth
      // more than pressing keys into it: an unanswered question blocks every prompt to this session.
      await this.escape(`could not be moved to "${choice.label}"`);
      return;
    }
    const settled = await this.settled();
    writeLog({
      level: settled ? "info" : "warn",
      message: settled ? "Answered a question Claude had open" : "Answered a question Claude had open, and Claude went on waiting",
      sessionId: this.options.sessionId,
      choice: choice.label,
      ...(settled ? {} : { screen: this.options.screen() }),
    });
  }

  private async escape(reason: string): Promise<void> {
    this.options.escape();
    const settled = await this.settled();
    writeLog({
      level: settled ? "info" : "warn",
      message: settled ? "Closed a question Claude had open" : "Could not close a question Claude had open",
      sessionId: this.options.sessionId,
      reason,
      ...(settled ? {} : { screen: this.options.screen() }),
    });
  }

  /** Whether Claude has stopped saying something has the keyboard, which is the only proof either way. */
  private async settled(): Promise<boolean> {
    const deadline = Date.now() + this.settleMs;
    do {
      if ((await this.options.waitingFor()) === null) return true;
      await delay(SETTLE_POLL_MS);
    } while (Date.now() < deadline);
    return false;
  }

  private async withdraw(reason: string): Promise<void> {
    const pending = this.pending;
    this.pending = null;
    if (!pending) return;
    pending.withdraw();
    writeLog({ level: "info", message: "Took back the card for a question Claude was asking", sessionId: this.options.sessionId, reason });
    await sendCardWithdrawn(this.options.connection, this.options.sessionId, pending.id);
  }
}

/**
 * One option per row Claude drew, and Dismiss whatever the reading found. They are all declining
 * options: Paseo's automatic modes accept an allow option without showing anybody a card, and this is
 * the one card that must never be answered by a machine -- some of these questions are about what
 * Claude may read, and the answer outlives the session that was asked.
 *
 * Dismiss goes first, because an answer that carries no action id -- `paseo permit deny`, a client with
 * a single button -- takes the first option of its behaviour, and here that is any of them.
 */
export function dialogOptions(dialog: DialogReading): PermissionOption[] {
  return [
    { optionId: DISMISS_OPTION_ID, name: "Dismiss (Esc)", kind: "reject_once" },
    ...dialog.choices.map((choice, index) => ({
      optionId: `${CHOICE_OPTION_PREFIX}${index}`,
      name: choice.label,
      kind: "reject_once" as const,
    })),
  ];
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
