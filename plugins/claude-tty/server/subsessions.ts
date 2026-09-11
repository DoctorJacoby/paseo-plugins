import type {
  ProviderConnection,
  ProviderEvent,
  ProviderInput,
  ProviderTimelineItem,
} from "@getpaseo/plugin/server/provider";
import type { SubagentSidecar } from "./subagent-transcripts.ts";

/** The capability the daemon has to offer before a child session may be opened at all. */
export const SUBSESSION_CAPABILITY = "session.subsession";

/** How often a subagent's transcript is re-read. Its launcher is often idle, so nothing else asks. */
const POLL_INTERVAL_MS = 1_000;

/** What a subagent left running when it stopped is closed with this, since nothing else will. */
const UNREPORTED = "Claude stopped before this agent reported back.";

/** All the wrapper needs of one subagent's transcript, which is what lets a test stand in for it. */
export type SubagentReader = {
  read(): Promise<ProviderTimelineItem[]>;
  settle(): ProviderTimelineItem[];
};

/**
 * Where a session's subagents are and what they have done. Kept behind a port because everything
 * here is timing and bookkeeping, and the disk underneath it is the adapter's own layout.
 */
export type SubagentSource = {
  /** The directory of subagent transcripts, once the adapter has recorded which Claude session this is. */
  locate(nativeSessionId: string, cwd: string): Promise<string | null>;
  list(directory: string): Promise<SubagentSidecar[]>;
  open(directory: string, agentId: string): SubagentReader;
};

type Child = { sessionId: string; toolUseId: string; reader: SubagentReader };

type Parent = {
  sessionId: string;
  cwd: string;
  /** The adapter's own session id, which is what names the state file recording the Claude session. */
  nativeSessionId: string | null;
  directory: string | null;
  /** The launches still open in the session's own conversation, by the tool call standing for each. */
  running: Set<string>;
  /** How a launch ended, which is the only word on whether the agent behind it is still alive. */
  ended: Map<string, "completed" | "failed">;
  children: Map<string, Child>;
  /** Agents already given a session, so one that has closed is never opened a second time. */
  seen: Set<string>;
};

/**
 * Surfaces Claude's subagents as Paseo subsessions. A subagent is a loop inside its session's
 * Claude process rather than an ACP session, so `runAcpProvider` has no way to describe one and the
 * capability is negotiated here: this wrapper adds `session.subsession` to what the connection
 * reports, adds it to every session the adapter opens, and emits the child sessions itself.
 *
 * The daemon fails the whole connection — every agent on this provider with it — for a child whose
 * parent never negotiated the capability, or whose parent it has already closed, so a parent is
 * tracked from its `session.opened` to whichever comes first of the daemon asking it to close and
 * the adapter reporting that it has.
 */
export function withSubagentSessions(
  connection: ProviderConnection,
  source: SubagentSource,
  offered: readonly string[],
  pollIntervalMs = POLL_INTERVAL_MS,
): ProviderConnection {
  // An older daemon offers no subsessions, and the adapter's cards in the conversation stay the
  // only place a subagent is shown. Nothing below runs, rather than running and being rejected.
  if (!offered.includes(SUBSESSION_CAPABILITY)) return connection;

  const capabilities = [...connection.capabilities, SUBSESSION_CAPABILITY];
  const listeners = new Set<(event: ProviderEvent) => void>();
  const parents = new Map<string, Parent>();
  let timer: ReturnType<typeof setInterval> | null = null;
  let polling = false;

  const emit = (event: ProviderEvent): void => {
    for (const listener of listeners) listener(event);
  };

  /**
   * A subagent is a loop inside its session's Claude process and stops with it, so a session going
   * closes every child it still had open. They are closed *before* the session is: the daemon
   * forgets a session as it accepts the close and refuses anything about it afterwards, and a child
   * left open then would go on saying it was working for as long as the agent existed.
   */
  const stopWatching = (sessionId: string): void => {
    const parent = parents.get(sessionId);
    if (parent === undefined) return;
    parents.delete(sessionId);
    for (const child of parent.children.values()) {
      for (const item of child.reader.settle()) emit({ type: "timeline.item", sessionId: child.sessionId, item });
      emit({ type: "session.closed", sessionId: child.sessionId, error: { message: UNREPORTED } });
    }
    parent.children.clear();
    if (parents.size === 0 && timer !== null) {
      clearInterval(timer);
      timer = null;
    }
  };

  const startWatching = (parent: Parent): void => {
    parents.set(parent.sessionId, parent);
    if (timer !== null) return;
    timer = setInterval(() => {
      if (polling) return;
      polling = true;
      void poll(parents, source, emit).finally(() => {
        polling = false;
      });
    }, pollIntervalMs);
    timer.unref?.();
  };

  const unsubscribe = connection.onEvent((event) => emit(accept(event)));

  return {
    version: connection.version,
    capabilities,
    async send(input: ProviderInput) {
      if (input.type === "session.close") stopWatching(input.sessionId);
      return connection.send(input);
    },
    // Subscribed to once whatever the daemon does, because the bookkeeping below is not idempotent:
    // a second reading of one `session.opened` would replace a session's children with none.
    onEvent(listener: (event: ProviderEvent) => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    async close() {
      for (const sessionId of [...parents.keys()]) stopWatching(sessionId);
      listeners.clear();
      unsubscribe();
      await connection.close();
    },
  };

  function accept(event: ProviderEvent): ProviderEvent {
    if (event.type === "session.opened" && event.parentSessionId === undefined) {
      startWatching({
        sessionId: event.sessionId,
        cwd: event.cwd,
        nativeSessionId: nativeSessionId(event.persistence),
        directory: null,
        running: new Set(),
        ended: new Map(),
        children: new Map(),
        seen: new Set(),
      });
      return { ...event, capabilities: [...event.capabilities, SUBSESSION_CAPABILITY] };
    }
    if (event.type === "session.closed" || event.type === "session.runtime_failed") {
      stopWatching(event.sessionId);
      return event;
    }
    if (event.type === "timeline.item") trackLaunch(parents.get(event.sessionId), event.item);
    return event;
  }
}

/**
 * The state of every tool call in the session's own conversation, which is where a subagent's
 * lifetime is decided. The adapter closes a launch when the agent reports and when the Claude
 * process it ran in stops, so a session whose process died says so here rather than going on
 * looking busy — which is what the transcript on its own could never tell anybody.
 */
function trackLaunch(parent: Parent | undefined, item: ProviderTimelineItem): void {
  if (parent === undefined || item.type !== "tool_call") return;
  if (item.status === "running") {
    parent.running.add(item.callId);
    return;
  }
  parent.running.delete(item.callId);
  parent.ended.set(item.callId, item.status === "completed" ? "completed" : "failed");
}

async function poll(
  parents: ReadonlyMap<string, Parent>,
  source: SubagentSource,
  emit: (event: ProviderEvent) => void,
): Promise<void> {
  for (const parent of [...parents.values()]) {
    // Only `session.opened` is fatal for a session the daemon has forgotten, and this reads the
    // disk between one event and the next, so the parent is checked again after every await.
    const alive = () => parents.get(parent.sessionId) === parent;
    if (!alive()) continue;
    await pollParent(parent, source, emit, alive).catch(() => undefined);
  }
}

async function pollParent(
  parent: Parent,
  source: SubagentSource,
  emit: (event: ProviderEvent) => void,
  alive: () => boolean,
): Promise<void> {
  if (parent.nativeSessionId === null) return;
  // Resolved every time rather than once: a session that compacts moves to a Claude session of its
  // own, and only the adapter's state file says which one it is on now. A reader already open keeps
  // the path it was opened with, because that is where the agent it is following writes.
  parent.directory = (await source.locate(parent.nativeSessionId, parent.cwd)) ?? parent.directory;
  if (parent.directory === null || !alive()) return;
  const sidecars = await source.list(parent.directory);
  if (!alive()) return;
  for (const sidecar of sidecars) {
    openChild(parent, sidecar, source, emit);
  }
  for (const [agentId, child] of [...parent.children]) {
    const items = await child.reader.read();
    if (!alive()) return;
    for (const item of items) {
      emit({ type: "timeline.item", sessionId: child.sessionId, item });
    }
    const ended = parent.ended.get(child.toolUseId);
    if (ended === undefined) continue;
    parent.children.delete(agentId);
    for (const item of child.reader.settle()) {
      emit({ type: "timeline.item", sessionId: child.sessionId, item });
    }
    emit({
      type: "session.closed",
      sessionId: child.sessionId,
      ...(ended === "failed" ? { error: { message: UNREPORTED } } : {}),
    });
  }
}

/**
 * A subagent gets a session while the launch that started it is still open, and never afterwards:
 * a transcript whose launch has already ended is history, and a launch nobody has seen is a nested
 * subagent's, whose spawner the session's conversation never names. Both stay on the card the
 * adapter draws in the conversation, which is the only place either was ever shown.
 */
function openChild(
  parent: Parent,
  sidecar: SubagentSidecar,
  source: SubagentSource,
  emit: (event: ProviderEvent) => void,
): void {
  if (parent.seen.has(sidecar.agentId) || sidecar.toolUseId === null || sidecar.nested) return;
  if (!parent.running.has(sidecar.toolUseId)) return;
  parent.seen.add(sidecar.agentId);
  const sessionId = `${parent.sessionId}:${sidecar.agentId}`;
  parent.children.set(sidecar.agentId, {
    sessionId,
    toolUseId: sidecar.toolUseId,
    reader: source.open(parent.directory ?? "", sidecar.agentId),
  });
  emit({
    type: "session.opened",
    sessionId,
    parentSessionId: parent.sessionId,
    // A subagent takes no instructions: it is handed one prompt by the session that launched it and
    // answers to that alone, and the daemon offers a child session no way to be prompted either.
    capabilities: [],
    // The session persists nothing of its own; its launcher's persistence carries the whole of it.
    restoration: "parent",
    cwd: parent.cwd,
    title: sidecar.agentType ?? "Subagent",
    ...(sidecar.description === null ? {} : { description: sidecar.description }),
  });
}

function nativeSessionId(persistence: { data: unknown } | undefined): string | null {
  const data = persistence?.data;
  if (data === null || typeof data !== "object" || Array.isArray(data)) return null;
  const sessionId = (data as Record<string, unknown>).sessionId;
  return typeof sessionId === "string" && sessionId !== "" ? sessionId : null;
}
