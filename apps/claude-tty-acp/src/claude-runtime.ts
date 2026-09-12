import { randomUUID } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { AgentSideConnection, ContentBlock, PromptResponse } from "@agentclientprotocol/sdk";
import * as nodePty from "node-pty";
import { type ContextWindow, contextWindow, formatTokens } from "./context-window.ts";
import { createDeferred, type Deferred } from "./deferred.ts";
import { type HookPayload, type HookRegistration, type HookResponse, HookServer } from "./hook-server.ts";
import { InteractionBridge } from "./interactions.ts";
import { writeLog } from "./log.ts";
import { cleanupPromptFiles, materializePrompt } from "./prompt-content.ts";
import { markRuntimeDirectory, runtimePrefix } from "./runtime-directories.ts";
import { INHERIT_EFFORT_ID, INHERIT_MODEL_ID } from "./session-options.ts";
import { type Placement, unboxedPlacement } from "./session-placement.ts";
import { TerminalScreen } from "./terminal-screen.ts";
import { SubagentWatcher } from "./subagent-watcher.ts";
import { TranscriptReader } from "./transcript-reader.ts";
import { TranscriptTranslator } from "./transcript-translator.ts";
import { TranscriptWatcher } from "./transcript-watcher.ts";

const STARTUP_TIMEOUT_MS = 15_000;
// Paseo replaces a prompt sent mid-turn by cancelling the running turn and waiting 2s for session/prompt to answer, then starts the replacement anyway and fails it when the old turn is still open.
// This fallback plus the transcript flush behind it has to settle well inside that budget.
const CANCEL_TIMEOUT_MS = 600;
const SUBMIT_DELAY_MS = 150;
/**
 * How long every subagent a turn launched may go without writing anything before the turn stops
 * waiting for them. Paseo reads a session as busy from the turn it has open, so an agent that never
 * reports would otherwise leave the session busy — and unsuspendable — for the rest of its life.
 */
const SUBAGENT_SILENCE_MS = 15 * 60_000;
/**
 * How long a held turn goes on after the last thing Claude wrote, whatever it is still waiting on, since a report wakes Claude for an answer that belongs inside the turn.
 * Claude writes a response to its transcript only once the whole of it has streamed, so a text followed by a long tool call — the prompt of the next agent it dispatches, say — shows nothing for as long as that call takes to generate, and a minute was not enough to cover one.
 */
const SUBAGENT_WAKE_MS = 5 * 60_000;
/**
 * How long a turn waits on a background command that has not reported.
 * The adapter does not follow the file a command writes its output to, so a running one shows nothing to measure a silence against: this is a flat bound from the moment the turn was held, started again whenever a command is launched or reports.
 * Thirty minutes because backgrounding is what Claude does with a command precisely when it takes a while, and the ones that run for longer than that are servers and poll loops, which never report at all and are exactly what the bound is here to let go of.
 */
const BACKGROUND_SHELL_MS = 30 * 60_000;
const SUBAGENT_POLL_MS = 5_000;
// Claude drops the submit key while it is still settling a paste, so the prompt is re-submitted until its input box lets go of it.
const SUBMIT_ATTEMPTS = 6;
const SUBMIT_CONFIRM_MS = 400;
const PASTE_ECHO_MS = 300;
// How long a paste that missed the window above is still waited for before the prompt is called undelivered.
// Claude reads a bracketed paste immediately and echoes it a render later, and on a loaded host that render
// is the thing that slips: the echo is what says the input box is holding the prompt, and a submit key sent
// before it lands leaves that prompt sitting there unsent, with no hook to end the turn waiting on it.
const LATE_PASTE_MS = 2_000;
const PROMPT_ECHO_CHARS = 40;
const BRACKETED_PASTE_START = "\u001b[200~";
const BRACKETED_PASTE_END = "\u001b[201~";
// Claude keeps its completion menu open while the cursor sits at the end of an @mention or a /command, and the submit key then picks an entry instead of sending the prompt.
// A trailing space closes the menu, so every paste ends with one.
const COMPLETION_DISMISS = " ";
const ESCAPE = "\u001b";
const CARRIAGE_RETURN = "\r";
const CONTROL_D = "\u0004";
const CURSOR_DOWN = "\u001b[B";
const ENTER = "\r";
const STARTUP_POLL_INTERVAL_MS = 25;
// Claude re-renders its status line after the Stop hook rather than before it, measured at ~320ms, so the reading for the turn that just ended only lands once the file changes again.
const CONTEXT_REFRESH_TIMEOUT_MS = 1_000;
const CONTEXT_REFRESH_POLL_MS = 25;
// A session whose status line never writes would otherwise wait the whole budget on every turn for a reading that is not coming.
// After this many turns without one it stops waiting and only looks, which costs a stat.
const CONTEXT_WAIT_MISS_LIMIT = 3;
// Looking alone cannot find a reading Claude writes after the Stop hook, so one turn in this many waits properly.
// Without that a session which starts reporting again would never be noticed, because every look lands before the write it is looking for.
const CONTEXT_WAIT_RETRY_TURNS = 4;
const WORKSPACE_TRUST_KEY_DELAY_MS = 500;
const WORKSPACE_TRUST_SELECTION_TIMEOUT_MS = 3_000;
// Claude puts its bypass permissions disclaimer up the same way it puts the trust screen up, and it settles no faster.
const BYPASS_PERMISSIONS_KEY_DELAY_MS = 500;
const BYPASS_PERMISSIONS_SELECTION_TIMEOUT_MS = 3_000;
// Claude asks how to resume a long or old conversation before it opens one, and answers that dialog the same way it answers the trust screen.
const STALE_RESUME_KEY_DELAY_MS = 200;
const STALE_RESUME_SELECTION_TIMEOUT_MS = 3_000;
// A resumed session paints its whole conversation before its input box exists, and text inside that conversation can satisfy every readiness signal on its own.
// Readiness therefore also requires Claude to have stopped painting, because a paste sent mid-restore is dropped without an echo to notice it by.
const READY_QUIET_MS = 400;
const HOOK_SOCKET_NAME = "hooks.sock";

/** One of the menus Claude opens on its way up, as the adapter has to answer it. */
type StartupMenu = {
  /** Still asking, which is the only reason to go on answering it. */
  onScreen: (screen: string) => boolean;
  /** The marker is on the option to take, so the next key is the one that confirms it. */
  selected: (screen: string) => boolean;
  keyDelayMs: number;
  timeoutMs: number;
  /** What to throw when Claude exits mid-answer. */
  exited: string;
};

type PtyProcess = Pick<nodePty.IPty, "pid" | "write" | "kill" | "onData" | "onExit">;
type SpawnPty = (file: string, args: string[], options: nodePty.IPtyForkOptions) => PtyProcess;

export type RuntimeDependencies = {
  spawnPty?: SpawnPty;
  startupTimeoutMs?: number;
  readinessTimeoutMs?: number;
  cancelTimeoutMs?: number;
  contextRefreshTimeoutMs?: number;
  submitDelayMs?: number;
  latePasteMs?: number;
  transcriptPollIntervalMs?: number;
  workspaceTrustKeyDelayMs?: number;
  workspaceTrustSelectionTimeoutMs?: number;
  bypassPermissionsKeyDelayMs?: number;
  bypassPermissionsSelectionTimeoutMs?: number;
  staleResumeKeyDelayMs?: number;
  staleResumeSelectionTimeoutMs?: number;
  readyQuietMs?: number;
  subagentPollMs?: number;
  subagentSilenceMs?: number;
  subagentWakeMs?: number;
  backgroundShellMs?: number;
  runtimeRoot?: string;
  claudeConfigDir?: string;
  /** Where this session's Claude runs. Left out, it runs beside the adapter, which is what every test wants. */
  placement?: Placement;
  transcriptFilePath?: string;
  stateDirectory?: string;
  translator?: TranscriptTranslator;
  resume?: boolean;
  model?: string;
  mode?: string;
  effort?: string;
  /** Whether a permission request is answered without a card, asked at each request. */
  autoAccept?: () => Promise<boolean>;
  onClaudeSessionChange?: (claudeSessionId: string) => Promise<void>;
};

type TurnResult = {
  response: PromptResponse;
  assistantMessage?: string;
};

export class ClaudeRuntime {
  readonly sessionId: string;
  readonly cwd: string;
  private currentClaudeSessionId: string;
  private readonly spawnPty: SpawnPty;
  private readonly startupTimeoutMs: number;
  private readonly readinessTimeoutMs: number;
  private readonly cancelTimeoutMs: number;
  private readonly contextRefreshTimeoutMs: number;
  private readonly submitDelayMs: number;
  private readonly latePasteMs: number;
  private readonly transcriptPollIntervalMs: number | undefined;
  private readonly workspaceTrustKeyDelayMs: number;
  private readonly workspaceTrustSelectionTimeoutMs: number;
  private readonly bypassPermissionsKeyDelayMs: number;
  private readonly bypassPermissionsSelectionTimeoutMs: number;
  private readonly staleResumeKeyDelayMs: number;
  private readonly staleResumeSelectionTimeoutMs: number;
  private readonly readyQuietMs: number;
  private readonly subagentPollMs: number;
  private readonly subagentSilenceMs: number;
  private readonly subagentWakeMs: number;
  private readonly backgroundShellMs: number;
  private readonly runtimeRoot: string;
  private readonly connection: AgentSideConnection;
  private readonly hooks: HookServer;
  private readonly placement: Placement;
  private readonly claudeConfigDir: string | undefined;
  /** The transcript the watcher is reading now, so a SessionStart naming that same file leaves it, and its offset, alone. */
  private transcriptFilePath!: string;
  private resumeNextLaunch: boolean;
  private model: string;
  private mode: string;
  private effort: string;
  private readonly onClaudeSessionChange: ((claudeSessionId: string) => Promise<void>) | undefined;
  private readonly interactions: InteractionBridge;
  private readonly translator: TranscriptTranslator;
  private transcript: TranscriptWatcher;
  private readonly screen = new TerminalScreen();
  private pty: PtyProcess | null = null;
  private runtimeDirectory: string | null = null;
  /** The short path this host binds a boxed session's hook socket at; see openHookSocket. */
  private hookSocketDirectory: string | null = null;
  private hookSocketPath: string | null = null;
  private hookRegistration: HookRegistration | null = null;
  private ready: Deferred<void> | null = null;
  private trustPrompt: Deferred<void> | null = null;
  private turn: Deferred<TurnResult> | null = null;
  private cancelTimer: NodeJS.Timeout | null = null;
  private cancelRequested = false;
  private assistantBaseline = 0;
  private closed = false;
  private contextFilePath: string | null = null;
  private contextMtimeAtTurnEnd = 0;
  private contextWaitCancelled = false;
  private contextWaitMisses = 0;
  private staleResumeAnswered = false;
  private backgroundHold: NodeJS.Timeout | null = null;
  private heldAssistantMessage: string | undefined;
  private heldAt = 0;
  /** When Claude last called a hook, which it does only while it is doing something. */
  private lastHookAt = 0;
  private intentionalExit: Deferred<void> | null = null;

  constructor(
    sessionId: string,
    claudeSessionId: string,
    cwd: string,
    connection: AgentSideConnection,
    hooks: HookServer,
    dependencies: RuntimeDependencies = {},
  ) {
    this.sessionId = sessionId;
    this.currentClaudeSessionId = claudeSessionId;
    this.cwd = cwd;
    this.connection = connection;
    this.hooks = hooks;
    this.placement = dependencies.placement ?? unboxedPlacement(cwd);
    // A boxed session's transcripts are in the box's own ~/.claude, which is a directory of this
    // host's that the box mounts, so the readers here go on reading them from outside.
    this.claudeConfigDir = dependencies.claudeConfigDir ?? this.placement.configDir;
    this.resumeNextLaunch = dependencies.resume === true;
    this.model = dependencies.model ?? INHERIT_MODEL_ID;
    this.mode = dependencies.mode ?? "default";
    this.effort = dependencies.effort ?? INHERIT_EFFORT_ID;
    this.onClaudeSessionChange = dependencies.onClaudeSessionChange;
    this.interactions = new InteractionBridge(sessionId, cwd, connection, dependencies.autoAccept);
    this.spawnPty = dependencies.spawnPty ?? nodePty.spawn;
    this.startupTimeoutMs = dependencies.startupTimeoutMs ?? STARTUP_TIMEOUT_MS;
    this.readinessTimeoutMs = dependencies.readinessTimeoutMs ?? STARTUP_TIMEOUT_MS;
    this.cancelTimeoutMs = dependencies.cancelTimeoutMs ?? CANCEL_TIMEOUT_MS;
    this.contextRefreshTimeoutMs = dependencies.contextRefreshTimeoutMs ?? CONTEXT_REFRESH_TIMEOUT_MS;
    this.submitDelayMs = dependencies.submitDelayMs ?? SUBMIT_DELAY_MS;
    this.latePasteMs = dependencies.latePasteMs ?? LATE_PASTE_MS;
    this.transcriptPollIntervalMs = dependencies.transcriptPollIntervalMs;
    this.workspaceTrustKeyDelayMs = dependencies.workspaceTrustKeyDelayMs ?? WORKSPACE_TRUST_KEY_DELAY_MS;
    this.workspaceTrustSelectionTimeoutMs = dependencies.workspaceTrustSelectionTimeoutMs ?? WORKSPACE_TRUST_SELECTION_TIMEOUT_MS;
    this.bypassPermissionsKeyDelayMs = dependencies.bypassPermissionsKeyDelayMs ?? BYPASS_PERMISSIONS_KEY_DELAY_MS;
    this.bypassPermissionsSelectionTimeoutMs = dependencies.bypassPermissionsSelectionTimeoutMs ?? BYPASS_PERMISSIONS_SELECTION_TIMEOUT_MS;
    this.staleResumeKeyDelayMs = dependencies.staleResumeKeyDelayMs ?? STALE_RESUME_KEY_DELAY_MS;
    this.staleResumeSelectionTimeoutMs = dependencies.staleResumeSelectionTimeoutMs ?? STALE_RESUME_SELECTION_TIMEOUT_MS;
    this.readyQuietMs = dependencies.readyQuietMs ?? READY_QUIET_MS;
    this.subagentPollMs = dependencies.subagentPollMs ?? SUBAGENT_POLL_MS;
    this.subagentSilenceMs = dependencies.subagentSilenceMs ?? SUBAGENT_SILENCE_MS;
    this.subagentWakeMs = dependencies.subagentWakeMs ?? SUBAGENT_WAKE_MS;
    this.backgroundShellMs = dependencies.backgroundShellMs ?? BACKGROUND_SHELL_MS;
    // A box reads none of this host's temporary directory, so where a boxed session's launch files
    // go is the placement's to say and not a caller's.
    this.runtimeRoot = this.placement.runtimeRoot ?? dependencies.runtimeRoot ?? os.tmpdir();
    this.translator = dependencies.translator ?? new TranscriptTranslator(sessionId, cwd, connection);
    this.transcript = this.createTranscriptWatcher(claudeSessionId, dependencies.transcriptFilePath);
  }

  get started(): boolean {
    return this.pty !== null;
  }

  get turnActive(): boolean {
    return this.turn !== null;
  }

  /** A permission or question card is on screen in Paseo and nobody has answered it yet. */
  get interactionPending(): boolean {
    return this.interactions.pending;
  }

  /**
   * When this session last showed any sign of life, whether or not a prompt was open: a hook Claude
   * called, a record it or one of its agents wrote, or a notification it was woken with. A turn is
   * only what Paseo asked for; Claude goes on working after one — launching agents, answering for
   * them — and that work is what this reports.
   */
  get activityAt(): number {
    return Math.max(this.translator.activityAt, this.lastHookAt);
  }

  async prompt(content: ContentBlock[]): Promise<PromptResponse> {
    if (this.closed) throw new Error(`Session ${this.sessionId} is closed`);
    if (this.turn) throw new Error(`Session ${this.sessionId} already has an active turn`);
    await this.ensureStarted();
    if (!this.runtimeDirectory) throw new Error(`Session ${this.sessionId} has no runtime directory`);
    // The attachments are written here and named to Claude, which for a boxed session reads them
    // through the mount at a path of its own; the checkout a resource_link points into is at the
    // same path on both sides, so only what this wrote moves.
    const prompt = await materializePrompt(content, this.runtimeDirectory, this.cwd, (file) => this.placement.guest(file));
    const turn = createDeferred<TurnResult>();
    this.turn = turn;
    this.cancelRequested = false;
    this.contextWaitCancelled = false;
    this.interactions.beginTurn();
    this.assistantBaseline = this.translator.assistantChunks;
    this.translator.trackBackgroundWork();
    try {
      await this.submit(prompt.text);
      const result = await turn.promise;
      if (result.assistantMessage) {
        this.translator.suppressNextAssistantText(result.assistantMessage);
        await this.connection.sessionUpdate({
          sessionId: this.sessionId,
          update: {
            sessionUpdate: "agent_message_chunk",
            messageId: randomUUID(),
            content: { type: "text", text: result.assistantMessage },
          },
        });
      }
      await this.emitContextUsage(result.response.stopReason);
      return result.response;
    } catch (error) {
      // A prompt that never reached Claude has no hook coming to end its turn, so the turn is let go of
      // here. Left standing it would hold the session busy for good and refuse every prompt after it.
      if (this.turn === turn) {
        this.turn = null;
        this.interactions.cancelPending();
        writeLog({ level: "error", message: "Failed to put a prompt to Claude", sessionId: this.sessionId, error: errorMessage(error) });
      }
      throw error;
    } finally {
      await cleanupPromptFiles(prompt.files);
    }
  }

  /** Claude takes its model and its effort at launch and offers no way to change either after, so this restarts it on the same conversation. */
  async reconfigure(model: string, mode: string, effort: string): Promise<void> {
    if (this.turn) throw new Error("Cannot change Claude model, mode or effort during an active turn");
    this.model = model;
    this.mode = mode;
    this.effort = effort;
    if (!this.pty) return;
    await this.stopForRestart();
    await this.ensureStarted();
  }

  /** Stop the native process without closing the logical ACP session or its persisted lock. */
  async suspend(): Promise<void> {
    if (this.closed || !this.pty) return;
    if (this.turn) throw new Error("Cannot suspend Claude during an active turn");
    this.interactions.cancelPending();
    await this.stopForRestart();
  }

  cancel(): void {
    // The wait for Claude's last context reading outlives the turn, so this is set before the turn check or a stop during it is dropped.
    this.contextWaitCancelled = true;
    // A card Claude raises on its way up is waiting before there is a turn to cancel, and letting go of the request is the only thing that ends that wait.
    this.interactions.cancelPending();
    const turn = this.turn;
    if (!turn) return;
    this.cancelRequested = true;
    if (this.cancelTimer) clearTimeout(this.cancelTimer);
    if (!this.pty) {
      this.cancelTimer = null;
      void this.finishCancelled();
      return;
    }
    this.pty.write(ESCAPE);
    this.cancelTimer = setTimeout(() => void this.finishCancelled(), this.cancelTimeoutMs);
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    if (this.cancelTimer) clearTimeout(this.cancelTimer);
    this.cancelTimer = null;
    this.ready?.reject(new Error(`Session ${this.sessionId} closed before Claude became ready`));
    this.ready = null;
    this.intentionalExit?.resolve();
    this.intentionalExit = null;
    this.finishTurn({ response: { stopReason: "cancelled" } });
    this.interactions.cancelPending();
    this.hookRegistration?.unregister();
    this.hookRegistration = null;
    const pty = this.pty;
    this.pty = null;
    if (pty) {
      try {
        pty.kill();
      } catch (error) {
        writeLog({ level: "warn", message: "Failed to stop Claude PTY", sessionId: this.sessionId, error: errorMessage(error) });
      }
    }
    await this.transcript.close();
    await this.settleOpenToolCalls();
    this.screen.dispose();
    await this.removeRuntimeDirectory();
  }

  private async ensureStarted(): Promise<void> {
    if (this.pty) return;
    this.screen.reset();
    this.staleResumeAnswered = false;
    // Before anything else, because a boxed project whose box will not start has nowhere to run,
    // and that is an error to raise here rather than a session quietly started on this host.
    await this.placement.prepare();
    await this.hooks.start();
    await mkdir(this.runtimeRoot, { recursive: true, mode: 0o700 });
    this.runtimeDirectory = await mkdtemp(runtimePrefix(this.runtimeRoot));
    await chmod(this.runtimeDirectory, 0o700);
    await markRuntimeDirectory(this.runtimeDirectory);
    this.hookRegistration = this.hooks.register(this.currentClaudeSessionId, (payload) => this.handleHook(payload));
    const hookClientPath = path.join(this.runtimeDirectory, "hook-client.mjs");
    await writeFile(hookClientPath, hookClientSource(await this.hookTarget(this.hookRegistration)), { mode: 0o600 });
    this.contextFilePath = path.join(this.runtimeDirectory, "context.json");
    const settingsPath = path.join(this.runtimeDirectory, "settings.json");
    // Every path in the settings is one Claude uses, so each is written as the process running
    // Claude sees it; the adapter keeps reading its own side of the same files.
    const hookCommand = `${shellQuote(this.placement.nodeCommand)} ${shellQuote(this.placement.guest(hookClientPath))}`;
    await writeFile(settingsPath, `${JSON.stringify(createSettings(hookCommand, this.placement.guest(this.contextFilePath)))}\n`, { mode: 0o600 });
    this.ready = createDeferred<void>();
    this.trustPrompt = createDeferred<void>();
    const sessionArgs = this.resumeNextLaunch
      ? ["--resume", this.currentClaudeSessionId]
      : ["--session-id", this.currentClaudeSessionId];
    const launch = this.placement.launch([
      ...sessionArgs,
      ...selectionArgs(this.model, this.mode, this.effort),
      "--settings",
      this.placement.guest(settingsPath),
    ]);
    try {
      // Still the interactive TUI under a pty, in a box as on the host: what changes is which
      // machine the terminal is attached to, and nothing about how the session is driven.
      this.pty = this.spawnPty(launch.file, launch.args, {
        name: "xterm-256color",
        cols: 120,
        rows: 40,
        cwd: this.cwd,
        env: launch.env,
      });
    } catch (error) {
      await this.failedStartup(`Could not start ${launch.file}: ${errorMessage(error)}`);
    }
    const started = this.pty;
    // A PTY that has been stopped can still flush its last output, and the screen it would land on now belongs to its replacement.
    started?.onData((data) => {
      if (this.pty !== started) return;
      this.screen.write(data, () => {
        const trustPrompt = this.trustPrompt;
        if (trustPrompt && isWorkspaceTrustScreen(this.screen.snapshot())) trustPrompt.resolve();
      });
    });
    started?.onExit(({ exitCode, signal }) => this.handleExit(started, exitCode, signal));
    try {
      await this.waitForSessionStart();
    } catch (error) {
      await this.failedStartup(errorMessage(error));
    } finally {
      this.ready = null;
      this.trustPrompt = null;
    }
    await this.waitForTerminalReady();
    await this.transcript.start();
    this.resumeNextLaunch = true;
    writeLog({
      level: "info",
      message: this.placement.boxed ? "Started interactive Claude session in its worktree box" : "Started interactive Claude session",
      sessionId: this.sessionId,
      claudePid: this.pty?.pid,
      cwd: this.cwd,
      boxed: this.placement.boxed,
    });
  }

  /**
   * How the hook client reaches this adapter. A session on this host posts to the loopback port the
   * hook server is on; a boxed one cannot see this host's loopback at all — a box reaches only the
   * ports its project asked to have forwarded — so it posts over a unix socket instead.
   */
  private async hookTarget(registration: HookRegistration): Promise<HookTarget> {
    if (!this.placement.boxed) return loopbackHookTarget(registration.endpoint);
    return { socketPath: await this.openHookSocket(), path: registration.requestPath };
  }

  /**
   * The socket goes in the runtime directory, which for a boxed session is inside the `~/.claude`
   * the box mounts, so both sides can reach the one file. It is bound through a symlink in this
   * host's temporary directory because a unix socket path may be about 107 bytes and a box's agent
   * home is nearly that on its own: `bind` resolves the leading directories, so a short path here
   * creates the socket over there. The box's own path to it is short to begin with.
   *
   * Returns that path, as the box sees it.
   */
  private async openHookSocket(): Promise<string> {
    if (!this.runtimeDirectory) throw new Error(`Session ${this.sessionId} has no runtime directory to put its hook socket in`);
    // Marked and prefixed like any runtime directory, so the sweep for the ones an abandoned
    // process left behind takes this one too.
    this.hookSocketDirectory = await mkdtemp(runtimePrefix(os.tmpdir()));
    await markRuntimeDirectory(this.hookSocketDirectory);
    const short = path.join(this.hookSocketDirectory, "box");
    await symlink(this.runtimeDirectory, short);
    this.hookSocketPath = path.join(short, HOOK_SOCKET_NAME);
    await this.hooks.listenOn(this.hookSocketPath);
    return this.placement.guest(path.join(this.runtimeDirectory, HOOK_SOCKET_NAME));
  }

  private async failedStartup(message: string): Promise<never> {
    // The message carries the terminal snapshot, and it has only ever travelled to Paseo as an error.
    // A handshake that failed is the thing nobody can reconstruct afterwards, so the log keeps it too.
    writeLog({ level: "error", message, sessionId: this.sessionId });
    this.hookRegistration?.unregister();
    this.hookRegistration = null;
    this.ready = null;
    this.trustPrompt = null;
    const pty = this.pty;
    this.pty = null;
    if (pty) {
      try {
        pty.kill();
      } catch {}
    }
    await this.removeRuntimeDirectory();
    throw new Error(message);
  }

  private async handleHook(payload: HookPayload): Promise<HookResponse> {
    this.lastHookAt = Date.now();
    switch (payload.hook_event_name) {
      // Hooks arrive over their own channel, ahead of the transcript the watcher is still polling.
      // Draining first keeps the prompt from landing before the assistant text that explains it.
      case "PreToolUse":
        await this.transcript.flushUntilStable();
        return this.interactions.handlePreToolUse(payload);
      case "PermissionRequest":
        await this.transcript.flushUntilStable();
        return this.interactions.handlePermissionRequest(payload);
      case "SessionStart":
        await this.handleSessionStart(payload);
        this.ready?.resolve();
        break;
      case "Stop":
        this.contextMtimeAtTurnEnd = await this.contextMtime();
        await this.transcript.flushUntilStable(true);
        if (this.cancelRequested) {
          this.finishTurn({ response: { stopReason: "cancelled" } });
          break;
        }
        // Claude goes idle the moment it launches a background agent or a background command, but the work it launched has not happened yet.
        // A command is dispatched exactly as an asynchronous agent is: the tool answers at the launch, Claude idles, and a <task-notification> wakes it when the work ends.
        // The turn is the only thing that tells Paseo a session is busy, so it is held open until every one of them has reported — and Claude has answered for them, since the notification that closes one wakes Claude for a turn of its own that ends in another Stop.
        this.heldAssistantMessage = asString(payload.last_assistant_message);
        if (this.turn && this.outstandingBackgroundWork > 0) {
          this.holdForBackgroundWork();
          break;
        }
        this.finishTurn({
          response: { stopReason: "end_turn" },
          assistantMessage: this.translator.assistantChunks === this.assistantBaseline ? this.heldAssistantMessage : undefined,
        });
        break;
      case "StopFailure":
        this.contextMtimeAtTurnEnd = await this.contextMtime();
        await this.transcript.flushUntilStable(true);
        this.finishTurn(
          this.cancelRequested
            ? { response: { stopReason: "cancelled" } }
            : {
                response: { stopReason: "refusal" },
                assistantMessage:
                  this.translator.assistantChunks === this.assistantBaseline
                    ? asString(payload.last_assistant_message) || asString(payload.error) || "Claude could not complete the turn."
                    : undefined,
              },
        );
        break;
      case "SessionEnd":
        await this.transcript.flushUntilStable(true);
        this.finishTurn({ response: { stopReason: "cancelled" } });
        break;
    }
    return {};
  }

  private handleExit(pty: PtyProcess, exitCode: number, signal?: number): void {
    if (this.closed) return;
    const current = this.pty === pty;
    if (this.intentionalExit) {
      if (current) this.pty = null;
      this.intentionalExit.resolve();
      return;
    }
    // A stop that outlived its own wait lands here after the restart has already replaced this PTY.
    // Tearing the session down on it would unregister the hooks, close the transcript and delete the runtime directory of the process that is now serving it.
    if (!current) return;
    const details = this.screen.snapshot();
    const error = new Error(`Claude PTY exited unexpectedly with code ${exitCode}${signal === undefined ? "" : ` and signal ${signal}`}.${details ? `\n${details}` : ""}`);
    this.ready?.reject(error);
    this.interactions.cancelPending();
    if (this.turn) {
      const turn = this.turn;
      this.turn = null;
      turn.reject(error);
    }
    this.pty = null;
    this.hookRegistration?.unregister();
    this.hookRegistration = null;
    void this.transcript
      .close()
      .catch((transcriptError) => {
        writeLog({ level: "warn", message: "Failed to stop Claude transcript watcher", sessionId: this.sessionId, error: errorMessage(transcriptError) });
      })
      .finally(() => this.settleOpenToolCalls());
    void this.removeRuntimeDirectory().catch((cleanupError) => {
      writeLog({ level: "warn", message: "Failed to remove Claude runtime directory", sessionId: this.sessionId, error: errorMessage(cleanupError) });
    });
  }

  private finishTurn(result: TurnResult): void {
    if (!this.turn) return;
    if (this.cancelTimer) clearTimeout(this.cancelTimer);
    this.cancelTimer = null;
    this.releaseBackgroundHold();
    this.cancelRequested = false;
    this.interactions.cancelPending();
    const turn = this.turn;
    this.turn = null;
    turn.resolve(result);
  }

  // Paseo's own usage meter is unreachable from an external ACP provider, so the reading goes in the timeline as text.
  // A cancelled turn is left alone, because Paseo only allows 2s for the prompt it is replacing to answer.
  private async emitContextUsage(stopReason: string): Promise<void> {
    if (stopReason === "cancelled" || this.closed || !this.contextFilePath) return;
    // The mtime rather than the contents marks this turn's reading, because two turns that land on the same numbers write identical files.
    // See the README on why it is taken at the Stop hook and compared against itself rather than against Date.now().
    const before = this.contextMtimeAtTurnEnd;
    const waits = this.contextWaitMisses < CONTEXT_WAIT_MISS_LIMIT || this.contextWaitMisses % CONTEXT_WAIT_RETRY_TURNS === 0;
    const deadline = Date.now() + this.contextRefreshTimeoutMs;
    do {
      const window = await this.readContextWindow(before);
      // Neither of these returns counts towards the latch, because neither a session closing nor a stop says anything about whether Claude writes readings.
      // The close is checked ahead of the send because the wait outlives the turn: a throw against a connection being torn down rejects a prompt that has already completed.
      if (this.closed) return;
      if (window) {
        this.contextWaitMisses = 0;
        await this.connection.sessionUpdate({
          sessionId: this.sessionId,
          update: {
            sessionUpdate: "agent_message_chunk",
            messageId: randomUUID(),
            content: { type: "text", text: `Context: ${formatTokens(window.tokens)} tokens (${window.percent}%)` },
          },
        });
        return;
      }
      if (this.contextWaitCancelled) return;
      if (!waits || Date.now() >= deadline) break;
      await delay(CONTEXT_REFRESH_POLL_MS);
    } while (true);
    this.contextWaitMisses += 1;
    if (this.contextWaitMisses === CONTEXT_WAIT_MISS_LIMIT) {
      writeLog({
        level: "debug",
        message: `Claude reported no context reading for ${CONTEXT_WAIT_MISS_LIMIT} turns; the adapter will wait on only one turn in ${CONTEXT_WAIT_RETRY_TURNS} from here`,
        sessionId: this.sessionId,
        contextFile: this.contextFilePath,
      });
    }
  }

  // Claude truncates the file before it rewrites it, so a torn read comes back as no reading and is waited out.
  // The catch is for the file going rather than for its contents: a close removes the runtime directory under a wait that has already stat'd it, and throwing here would reject a turn that has completed.
  private async readContextWindow(rewrittenAfter: number): Promise<ContextWindow | null> {
    if (!this.contextFilePath) return null;
    const mtime = await this.contextMtime();
    if (mtime <= rewrittenAfter) return null;
    try {
      return contextWindow(await readFile(this.contextFilePath, "utf8"));
    } catch {
      return null;
    }
  }

  private async contextMtime(): Promise<number> {
    if (!this.contextFilePath) return 0;
    try {
      return (await stat(this.contextFilePath)).mtimeMs;
    } catch {
      return 0;
    }
  }

  /** Everything Claude launched to run on its own and is still owed a report for. */
  private get outstandingBackgroundWork(): number {
    return this.translator.runningSubagents + this.translator.runningBackgroundShells;
  }

  /** Watches from outside the hook channel, because stuck work produces no hook to answer. */
  private holdForBackgroundWork(): void {
    if (this.backgroundHold) return;
    writeLog({
      level: "info",
      message: "Holding the turn open for background work",
      sessionId: this.sessionId,
      agents: this.translator.runningSubagents,
      shells: this.translator.runningBackgroundShells,
    });
    this.heldAt = Date.now();
    this.backgroundHold = setInterval(() => this.reviewBackgroundHold(), this.subagentPollMs);
    this.backgroundHold.unref();
  }

  /**
   * A hold that is simply over ends at the Stop hook.
   * This is only the way out of one that is not, and each kind of work waited on has a bound of its own: the turn ends when every one of them has run out, never while one is still inside its own.
   */
  private reviewBackgroundHold(): void {
    if (!this.turn) {
      this.releaseBackgroundHold();
      return;
    }
    const agents = this.translator.runningSubagents;
    const shells = this.translator.runningBackgroundShells;
    const now = Date.now();
    // Nothing is given up on while Claude is still writing, whatever it is that woke it: an answer cut off by the poll that follows the report it answers is the very thing the hold is for.
    if (now - this.answerProgressAt() < this.subagentWakeMs) return;
    if (agents > 0 && now - this.agentProgressAt() < this.subagentSilenceMs) return;
    if (shells > 0 && now - this.shellProgressAt() < this.backgroundShellMs) return;
    // The bound that ran out, which is the one the message below is about.
    const silent = now - (agents > 0 ? this.agentProgressAt() : shells > 0 ? this.shellProgressAt() : this.answerProgressAt());
    writeLog({
      level: "warn",
      message:
        agents > 0
          ? "Ending a turn whose background agents have gone quiet"
          : shells > 0
            ? "Ending a turn whose background commands never reported"
            : "Ending a turn Claude never answered its background work in",
      sessionId: this.sessionId,
      agents,
      shells,
      // Which ones, because a turn held by work that has already gone is the hard one to read back.
      agentIds: this.translator.outstandingSubagents,
      shellIds: this.translator.outstandingBackgroundShells,
      silentMs: silent,
    });
    // The turn has stopped waiting on this work, so nothing else goes on counting it either: every later turn would hold for a poll interval and give up again in the same breath.
    this.translator.abandonBackgroundWork();
    this.finishTurn({
      response: { stopReason: "end_turn" },
      assistantMessage: this.translator.assistantChunks === this.assistantBaseline ? this.heldAssistantMessage : undefined,
    });
  }

  /** An agent still running shows it by writing, and nothing Claude does says whether it is alive, so this reads only the agents and the hold itself. */
  private agentProgressAt(): number {
    return Math.max(this.translator.subagentActivityAt, this.heldAt);
  }

  /** When a background command was last launched or reported, or the hold began, whichever is latest. */
  private shellProgressAt(): number {
    return Math.max(this.translator.backgroundShellActivityAt, this.heldAt);
  }

  /** Claude answering for work that has reported is exactly what the wake bound waits for, so anything Claude writes counts towards it: what it says, what it thinks, and the tools it runs on the way. */
  private answerProgressAt(): number {
    return Math.max(
      this.translator.subagentActivityAt,
      this.translator.backgroundShellActivityAt,
      this.translator.assistantActivityAt,
      this.heldAt,
    );
  }

  /**
   * Anything Claude was running has stopped with it, so the cards standing for that work are closed
   * rather than left turning. Never worth failing a shutdown over: a session reloaded later replays
   * its transcript, which closes them again.
   */
  private async settleOpenToolCalls(): Promise<void> {
    try {
      await this.translator.settleOpenToolCalls();
    } catch (error) {
      writeLog({ level: "warn", message: "Could not close the tool calls a stopped session left running", sessionId: this.sessionId, error: errorMessage(error) });
    }
  }

  private releaseBackgroundHold(): void {
    if (this.backgroundHold) clearInterval(this.backgroundHold);
    this.backgroundHold = null;
    this.heldAssistantMessage = undefined;
  }

  private async finishCancelled(): Promise<void> {
    await this.transcript.flushUntilStable(true);
    this.finishTurn({ response: { stopReason: "cancelled" } });
  }

  private async handleSessionStart(payload: HookPayload): Promise<void> {
    const nextClaudeSessionId = asString(payload.session_id);
    // Claude reports its transcript at its own path, which in a box is a path of the box's.
    const reported = asString(payload.transcript_path);
    const transcriptFilePath = reported === undefined ? undefined : this.placement.host(reported);
    const source = asString(payload.source);
    if (source === "clear" && nextClaudeSessionId && nextClaudeSessionId !== this.currentClaudeSessionId) {
      await this.transcript.close();
      this.currentClaudeSessionId = nextClaudeSessionId;
      this.hookRegistration?.addSessionId(nextClaudeSessionId);
      this.transcript = this.createTranscriptWatcher(nextClaudeSessionId, transcriptFilePath);
      await this.transcript.start();
      await this.onClaudeSessionChange?.(nextClaudeSessionId);
      return;
    }
    if (transcriptFilePath && transcriptFilePath !== this.transcriptFilePath) {
      await this.transcript.close();
      this.transcript = this.createTranscriptWatcher(this.currentClaudeSessionId, transcriptFilePath);
    }
  }

  private createTranscriptWatcher(claudeSessionId: string, filePath?: string): TranscriptWatcher {
    const reader = new TranscriptReader(claudeSessionId, this.cwd, { configDir: this.claudeConfigDir, filePath });
    this.transcriptFilePath = reader.filePath;
    return new TranscriptWatcher(
      reader,
      this.translator,
      this.transcriptPollIntervalMs,
      new SubagentWatcher(reader.filePath, this.translator, this.cwd),
    );
  }

  private async removeRuntimeDirectory(): Promise<void> {
    const socketPath = this.hookSocketPath;
    const socketDirectory = this.hookSocketDirectory;
    const directory = this.runtimeDirectory;
    this.hookSocketPath = null;
    this.hookSocketDirectory = null;
    this.runtimeDirectory = null;
    // The socket's listener first: closing it unlinks the file, which is inside the directory below.
    if (socketPath) await this.hooks.stopListeningOn(socketPath);
    if (socketDirectory) await rm(socketDirectory, { force: true, recursive: true });
    if (directory) await rm(directory, { force: true, recursive: true });
  }

  private async stopForRestart(): Promise<void> {
    const pty = this.pty;
    if (!pty) return;
    this.intentionalExit = createDeferred<void>();
    pty.write(CONTROL_D);
    await Promise.race([this.intentionalExit.promise, new Promise<void>((resolve) => setTimeout(resolve, 500))]);
    if (this.pty === pty) {
      try {
        pty.kill();
      } catch {}
      this.pty = null;
      await Promise.race([this.intentionalExit.promise, new Promise<void>((resolve) => setTimeout(resolve, 50))]);
    }
    this.intentionalExit = null;
    this.hookRegistration?.unregister();
    this.hookRegistration = null;
    // The last thing written may be the notification that closes an agent, and the reader has to be open to see it.
    await this.transcript.flushUntilStable(true);
    await this.transcript.close();
    await this.settleOpenToolCalls();
    await this.removeRuntimeDirectory();
  }

  /**
   * Puts the prompt in Claude's input box and sends it, and says so when it could not.
   *
   * Every way a turn ends is a hook Claude fires, so a prompt Claude never took ends nothing: the turn
   * stays open for the rest of the session, the client shows it working, and the message is gone without
   * a line anywhere. That is worth an error rather than a silence, so this only returns on evidence that
   * the prompt went in — the input box letting go of it, or the turn moving on by itself.
   */
  private async submit(text: string): Promise<void> {
    const activityBefore = this.activityAt;
    this.pty?.write(`${BRACKETED_PASTE_START}${text}${COMPLETION_DISMISS}${BRACKETED_PASTE_END}`);
    const echo = promptEcho(text);
    let pasted = await this.screenSettles((screen) => inputBoxHolds(screen, echo), PASTE_ECHO_MS);
    for (let attempt = 0; attempt < SUBMIT_ATTEMPTS; attempt += 1) {
      await delay(this.submitDelayMs);
      if (this.cancelRequested) return;
      this.pty?.write(CARRIAGE_RETURN);
      if (pasted) {
        if (await this.screenSettles((screen) => !inputBoxHolds(screen, echo), SUBMIT_CONFIRM_MS)) return;
        continue;
      }
      // The key above went into an input box with nothing of ours in it, so it sent nothing. Claude
      // settles a long paste a render after it reads it, and a prompt that turns up behind a spent
      // submit key sits in the box unsent -- so the echo is waited for rather than assumed absent,
      // and sent properly on the next attempt once it lands.
      if (!inputBoxVisible(this.screen.snapshot())) return;
      pasted = await this.screenSettles((screen) => inputBoxHolds(screen, echo), this.latePasteMs);
      if (!pasted) {
        if (this.submissionMovedOn(activityBefore)) return;
        throw new Error(`Claude never took the prompt for session ${this.sessionId}: it did not appear in Claude's input box.`);
      }
    }
    if (this.submissionMovedOn(activityBefore)) return;
    throw new Error(`Claude kept the prompt for session ${this.sessionId} in its input box after ${SUBMIT_ATTEMPTS} submit attempts.`);
  }

  /**
   * Whether the prompt went in after all, read from something other than the input box.
   * The box is sampled, not followed, so a prompt taken between two samples leaves no trace in it —
   * and calling that one undelivered would fail a turn that is running.
   */
  private submissionMovedOn(activityBefore: number): boolean {
    return this.turn === null || this.activityAt > activityBefore;
  }

  private async screenSettles(predicate: (screen: string) => boolean, timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    do {
      if (predicate(this.screen.snapshot())) return true;
      await delay(25);
    } while (Date.now() < deadline);
    return false;
  }

  private async waitForTerminalReady(): Promise<void> {
    if (this.readinessTimeoutMs === 0) return;
    let deadline = Date.now() + this.readinessTimeoutMs;
    while (Date.now() < deadline) {
      const screen = this.screen.snapshot();
      if (!this.staleResumeAnswered && isStaleResumeScreen(screen)) {
        await this.keepFullSession();
        // Claude reads the whole conversation in only after the answer, so readiness gets a fresh window rather than the remains of this one.
        deadline = Date.now() + this.readinessTimeoutMs;
        continue;
      }
      if (isReadyScreen(screen) && this.screen.quietFor(this.readyQuietMs)) return;
      await delay(STARTUP_POLL_INTERVAL_MS);
    }
    await this.failedStartup(`Claude completed its SessionStart hook but its interactive prompt did not become ready within ${this.readinessTimeoutMs}ms. Check the terminal output:\n${this.screen.snapshot()}`);
  }

  /**
   * Claude offers to replace a long or old conversation with a summary of it before resuming.
   * The adapter always keeps the conversation, because that conversation is the ACP session it was asked to restore;
   * a summary would silently discard the history Paseo has already replayed into its timeline.
   */
  private async keepFullSession(): Promise<void> {
    this.staleResumeAnswered = true;
    const answer = await this.answerStartupMenu({
      onScreen: isStaleResumeScreen,
      selected: isFullSessionSelected,
      keyDelayMs: this.staleResumeKeyDelayMs,
      timeoutMs: this.staleResumeSelectionTimeoutMs,
      exited: "Claude exited before its resume question could be answered",
    });
    if (answer === "confirmed") {
      writeLog({ level: "info", message: "Kept the full conversation at Claude's resume question", sessionId: this.sessionId });
      return;
    }
    // The question is gone and Claude is resuming on an answer the adapter did not give. Which answer
    // that was is not on screen to read, and a session carrying on is worth more than a certain one.
    if (answer === "gone") {
      writeLog({ level: "warn", message: "Claude's resume question was answered before the adapter could take it", sessionId: this.sessionId });
      return;
    }
    await this.failedStartup(`Claude asked how to resume this session and the adapter could not select "Resume full session as-is". Terminal output:\n${this.screen.snapshot()}`);
  }

  /**
   * Answers one of the menus Claude opens on its way up: put the marker on the option, confirm it,
   * and wait for the question to go. Claude paints a menu just before its input state settles and
   * drops whatever arrives in that gap — the trust screen visibly rolls its selection back — so a
   * key is sent again for as long as the screen says the last one did not land, rather than once
   * after a delay guessed in advance.
   */
  private async answerStartupMenu(menu: StartupMenu): Promise<"confirmed" | "gone" | "stuck"> {
    const pty = this.pty;
    if (!pty) throw new Error(menu.exited);
    const deadline = Date.now() + menu.timeoutMs;
    // The menu has just been painted, so the first key waits for the input state behind it.
    await delay(menu.keyDelayMs);
    while (Date.now() < deadline) {
      if (this.pty !== pty) throw new Error(menu.exited);
      const screen = this.screen.snapshot();
      if (!menu.onScreen(screen)) return "gone";
      if (menu.selected(screen)) {
        // The marker moves before the input behind it does, so the choice is read once more on the way out.
        await delay(menu.keyDelayMs);
        if (this.pty !== pty) throw new Error(menu.exited);
        if (!menu.selected(this.screen.snapshot())) continue;
        pty.write(ENTER);
        return "confirmed";
      }
      pty.write(CURSOR_DOWN);
      await delay(Math.max(menu.keyDelayMs, STARTUP_POLL_INTERVAL_MS));
    }
    return menu.onScreen(this.screen.snapshot()) ? "stuck" : "gone";
  }

  private async waitForSessionStart(): Promise<void> {
    if (!this.ready) throw new Error("Claude startup readiness was not initialized");
    if (!this.trustPrompt) throw new Error("Claude workspace-trust detection was not initialized");
    const ready = this.ready.promise.then(() => "ready" as const);
    const trustPrompt = this.trustPrompt.promise.then(() => "trust-prompt" as const);
    let deadline = Date.now() + this.startupTimeoutMs;
    let trustHandled = false;
    let bypassHandled = false;
    while (true) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new Error(this.startupTimeoutMessage());
      const waits: Array<Promise<"ready" | "poll" | "trust-prompt">> = [
        ready,
        delay(Math.min(STARTUP_POLL_INTERVAL_MS, remaining)).then(() => "poll" as const),
      ];
      if (!trustHandled) waits.push(trustPrompt);
      const result = await Promise.race(waits);
      if (result === "ready") return;
      if (!this.staleResumeAnswered && isStaleResumeScreen(this.screen.snapshot())) {
        await this.keepFullSession();
        deadline = Date.now() + this.startupTimeoutMs;
        continue;
      }
      // Claude only raises the disclaimer for the mode that is gated on it, and a resumed session repaints a conversation that may quote the dialog it is asking about.
      if (!bypassHandled && this.mode === "bypassPermissions" && isBypassPermissionsScreen(this.screen.snapshot())) {
        bypassHandled = true;
        const accepted = await this.interactions.requestBypassPermissions();
        if (!accepted) throw new Error("Claude asks for the Bypass Permissions disclaimer before it will start in that mode, and it was not accepted in Paseo.");
        await this.acceptBypassPermissions();
        // As with workspace trust: the window that was running covered a handshake, not a person reading a warning.
        deadline = Date.now() + this.startupTimeoutMs;
        continue;
      }
      if (trustHandled || (result !== "trust-prompt" && !isWorkspaceTrustScreen(this.screen.snapshot()))) continue;
      trustHandled = true;
      const approved = await this.interactions.requestWorkspaceTrust();
      if (!approved) throw new Error(`Claude requires workspace trust for ${this.cwd}, but it was not approved in Paseo.`);
      await this.confirmWorkspaceTrust();
      // A human may take longer than the normal startup window to answer the permission card.
      // Give Claude a full handshake window after the explicit decision.
      deadline = Date.now() + this.startupTimeoutMs;
    }
  }

  private startupTimeoutMessage(): string {
    return `Claude did not complete the SessionStart hook handshake within ${this.startupTimeoutMs}ms. Check Claude hook policy and the terminal output:\n${this.screen.snapshot()}`;
  }

  private async acceptBypassPermissions(): Promise<void> {
    const answer = await this.answerStartupMenu({
      onScreen: isBypassPermissionsScreen,
      selected: isBypassPermissionsAccepted,
      keyDelayMs: this.bypassPermissionsKeyDelayMs,
      timeoutMs: this.bypassPermissionsSelectionTimeoutMs,
      exited: "Claude exited before the Bypass Permissions disclaimer could be accepted",
    });
    if (answer === "gone") {
      writeLog({ level: "warn", message: "Claude's Bypass Permissions disclaimer was answered before the adapter could take it", sessionId: this.sessionId });
    }
    if (answer === "stuck") {
      throw new Error(`Claude did not select "Yes, I accept" on its Bypass Permissions disclaimer after it was accepted in Paseo. Terminal output:\n${this.screen.snapshot()}`);
    }
  }

  private async confirmWorkspaceTrust(): Promise<void> {
    const answer = await this.answerStartupMenu({
      onScreen: isWorkspaceTrustScreen,
      selected: isWorkspaceTrustSelected,
      keyDelayMs: this.workspaceTrustKeyDelayMs,
      timeoutMs: this.workspaceTrustSelectionTimeoutMs,
      exited: "Claude exited before workspace trust could be confirmed",
    });
    if (answer === "gone") {
      writeLog({ level: "warn", message: "Claude's workspace trust question was answered before the adapter could take it", sessionId: this.sessionId });
    }
    if (answer === "stuck") {
      throw new Error(`Claude did not select the workspace trust option after approval in Paseo. Terminal output:\n${this.screen.snapshot()}`);
    }
  }
}

function createSettings(command: string, contextFilePath: string): Record<string, unknown> {
  const lifecycleHook = { type: "command", command, timeout: 30 };
  // These two hooks render a card and wait for the person to answer it, which the default 600 seconds does not allow for.
  // At the timeout Claude kills the hook and treats the call as undecided, then asks its own permission pipeline instead, which reaches the user as a second card for a tool they are already looking at.
  const interactionHook = { type: "command", command, timeout: 86_400 };
  return {
    // Claude's status line is the only place it reports the tokens in the context window as a share of the window holding them.
    // Claude runs the command through a shell and renders its stdout, so this writes the payload to a file and prints nothing.
    // It runs when the reading changes rather than on a timer, which is at least once per assistant response.
    statusLine: { type: "command", command: `cat > ${shellQuote(contextFilePath)}` },
    hooks: {
      PreToolUse: [{ hooks: [interactionHook] }],
      PermissionRequest: [{ hooks: [interactionHook] }],
      SessionStart: [{ hooks: [lifecycleHook] }],
      Stop: [{ hooks: [lifecycleHook] }],
      StopFailure: [{ hooks: [lifecycleHook] }],
      SessionEnd: [{ hooks: [lifecycleHook] }],
    },
  };
}

/**
 * Where the hook client posts. A session on this host reaches the adapter on the loopback port; one
 * in a box reaches none of this host's loopback and posts over a unix socket instead. Either is
 * node:http request options, so the client that carries them is the same client.
 */
type HookTarget = { host: string; port: string; path: string } | { socketPath: string; path: string };

export function loopbackHookTarget(endpoint: string): HookTarget {
  const url = new URL(endpoint);
  return { host: url.hostname, port: url.port, path: `${url.pathname}${url.search}` };
}

// A hook that renders a card waits for as long as the person does, so this posts over node:http rather than fetch.
// Node's fetch is undici, whose headersTimeout gives up on the response after 300 seconds; node:http imposes no such deadline.
function hookClientSource(target: HookTarget): string {
  return `import http from "node:http";
const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
const payload = Buffer.concat(chunks);
const status = await new Promise((resolve, reject) => {
  const request = http.request({ ...${JSON.stringify(target)}, method: "POST", headers: { "content-type": "application/json", "content-length": payload.length } }, (response) => {
    const parts = [];
    response.on("data", (part) => parts.push(part));
    response.on("end", () => {
      const body = Buffer.concat(parts).toString();
      if (body) process.stdout.write(body);
      resolve(response.statusCode ?? 0);
    });
  });
  request.on("error", reject);
  request.end(payload);
});
if (status < 200 || status > 299) process.exitCode = 1;
`;
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function selectionArgs(model: string, mode: string, effort: string): string[] {
  const args: string[] = [];
  if (model !== INHERIT_MODEL_ID) args.push("--model", model);
  if (mode !== "default") args.push("--permission-mode", mode);
  if (effort !== INHERIT_EFFORT_ID) args.push("--effort", effort);
  return args;
}

function promptEcho(text: string): string {
  return text.trim().split("\n", 1)[0]!.trim().slice(0, PROMPT_ECHO_CHARS);
}

/**
 * Whether Claude's input box is on screen at all, empty or not.
 * An empty box only means the prompt is not in it where there is a box to read: a session whose terminal
 * has painted nothing -- every test's fake PTY, and a real one before Claude's first render -- says nothing
 * either way, and is left to the submit key rather than called a failure.
 */
function inputBoxVisible(screen: string): boolean {
  return /^\s*❯/m.test(screen);
}

// The last prompt marker on screen is Claude's input box; the ones above it are prompts it has already taken.
function inputBoxHolds(screen: string, echo: string): boolean {
  const lines = screen.split("\n");
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const match = /^\s*❯\s?(.*)$/.exec(lines[index]!);
    if (match) return match[1]!.trim().startsWith(echo);
  }
  return false;
}

// Registering a status line makes Claude drop most footer hints, `? for shortcuts` among them, so that alternative cannot match in an adapter-launched session.
// The mode indicator carries readiness in its place and is present in every mode, `manual mode on` in the default one; the token badge is absent until a session has context, and the bare prompt marker does not match while the input box still holds its placeholder.
// Each indicator is spelled out because the footer is the indicator Claude keeps for the mode plus ` on`, and half of them do not end in `mode`: `accept edits on`, `bypass permissions on` and `don't ask on` are what those sessions print.
// `don't ask` is here although the mode selector does not offer it, because Paseo's Default mode sends no `--permission-mode` and leaves the session in whatever `permissions.defaultMode` Claude's settings name.
const MODE_INDICATORS = ["auto mode", "plan mode", "manual mode", "accept edits", "bypass permissions", "don't ask"];
const READY_SCREEN = new RegExp(
  `\\?\\s+for shortcuts|\\d+(?:\\.\\d+)?[km]?/\\d+(?:\\.\\d+)?[km]? tokens|(?:${MODE_INDICATORS.join("|")}) on|(^|\\n)\\s*❯\\s*($|\\n)`,
  "i",
);

function isReadyScreen(screen: string): boolean {
  return READY_SCREEN.test(screen);
}

function isWorkspaceTrustScreen(screen: string): boolean {
  return (
    /Accessing workspace:/i.test(screen) &&
    /Quick safety check:/i.test(screen) &&
    /No,\s*exit/i.test(screen) &&
    /Yes,\s*I trust this folder/i.test(screen) &&
    /Enter to confirm/i.test(screen)
  );
}

/**
 * Claude gates bypass permissions on a one-time acknowledgement kept per host, in
 * `skipDangerousModePermissionPrompt`, and puts this dialog in front of the first session that asks
 * for the mode without it. Nothing else on the startup path carries this title next to these options.
 */
function isBypassPermissionsScreen(screen: string): boolean {
  return (
    /WARNING: Claude Code running in Bypass Permissions mode/i.test(screen) &&
    /No,\s*exit/i.test(screen) &&
    /Yes,\s*I accept/i.test(screen) &&
    /Enter to confirm/i.test(screen)
  );
}

function isBypassPermissionsAccepted(screen: string): boolean {
  return /(?:^|\n)[ \t]*❯[ \t]*Yes,[ \t]*I accept[ \t]*(?:$|\n)/i.test(screen);
}

// Claude shows this before it opens a conversation it considers long or old, and nothing else on its startup path offers these four lines together.
function isStaleResumeScreen(screen: string): boolean {
  return (
    /Resuming the full session will consume a substantial portion of your usage limits/i.test(screen) &&
    /Resume from summary/i.test(screen) &&
    /Resume full session as-is/i.test(screen) &&
    /Enter to confirm/i.test(screen)
  );
}

/** The options are numbered on screen, so the marker sits ahead of the number rather than the label. */
function isFullSessionSelected(screen: string): boolean {
  return /(?:^|\n)[ \t]*❯[ \t]*(?:\d+\.[ \t]*)?Resume full session as-is[ \t]*(?:$|\n)/i.test(screen);
}

function isWorkspaceTrustSelected(screen: string): boolean {
  return /(?:^|\n)[ \t]*❯[ \t]*Yes,[ \t]*I trust this folder(?:$|\n)/i.test(screen);
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
