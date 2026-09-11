import type { PluginSurfaceProps } from "@getpaseo/plugin/client";
import { useRpc } from "@getpaseo/plugin/client";
import { SettingsCard, SettingsRow, SettingsSection } from "@getpaseo/plugin/client/ui";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import React, { useState } from "react";
import { Pressable, Text, View } from "react-native";
import * as contracts from "../shared/contracts.ts";
import type { SessionsPayload } from "../shared/contracts.ts";
import { groupSessions, lastActiveLabel } from "../shared/sessions.ts";
import { fontSize, leading, spacing, type Palette } from "./theme.ts";
import { ConfirmButton } from "./confirm.tsx";
import { Monospace, ReadingRow, type Reading } from "./status.tsx";
import { Button, pressable } from "./ui.tsx";

export const SESSIONS_QUERY_KEY = ["claude-tty", "sessions"];
const REFETCH_MS = 10_000;

type Session = SessionsPayload["sessions"][number];
type Navigation = PluginSurfaceProps["navigation"];

export function SessionsSection({ palette, navigation }: { palette: Palette; navigation: Navigation }) {
  const [showOlder, setShowOlder] = useState(false);
  const queryClient = useQueryClient();
  const getSessions = useRpc(contracts.getSessions);
  const releaseLock = useRpc(contracts.releaseLock);
  const quarantineSession = useRpc(contracts.quarantineSession);
  const stopSession = useRpc(contracts.stopSession);

  const query = useQuery({
    queryKey: SESSIONS_QUERY_KEY,
    queryFn: () => getSessions({}),
    refetchInterval: REFETCH_MS,
  });
  const onSuccess = (next: SessionsPayload) => queryClient.setQueryData(SESSIONS_QUERY_KEY, next);
  const release = useMutation({ mutationFn: (id: string) => releaseLock({ id }), onSuccess });
  const quarantine = useMutation({ mutationFn: (id: string) => quarantineSession({ id }), onSuccess });
  const stop = useMutation({ mutationFn: (id: string) => stopSession({ id }), onSuccess });

  const payload = query.data ?? null;
  const busy = release.isPending || quarantine.isPending || stop.isPending;
  const failure = release.error ?? quarantine.error ?? stop.error ?? null;
  // A stop waits on a process, so the row it is waiting on says so rather than just going flat.
  const stopping = stop.isPending ? stop.variables : null;
  const groups = payload === null ? null : groupSessions(payload.sessions, payload.now);

  const row = (session: Session, now: number) => (
    <ReadingRow
      key={session.id}
      palette={palette}
      title={title(session)}
      reading={reading(session, now)}
      trailing={
        <View style={{ flexDirection: "row", alignItems: "center", gap: spacing[2] }}>
          <OpenAgent palette={palette} navigation={navigation} agent={session.agent} />
          <SessionAction
            palette={palette}
            session={session}
            busy={busy}
            stopping={session.id === stopping}
            onRelease={() => release.mutate(session.id)}
            onQuarantine={() => quarantine.mutate(session.id)}
            onStop={() => stop.mutate(session.id)}
          />
        </View>
      }
    />
  );

  return (
    <SettingsSection title="Sessions">
      {groups === null || payload === null ? null : payload.sessions.length === 0 ? (
        <SettingsCard>
          <SettingsRow label="No saved sessions" hint={payload.stateDirectory} />
        </SettingsCard>
      ) : (
        <SettingsCard>
          {groups.visible.map((session) => row(session, payload.now))}
          {groups.older.length === 0 ? null : (
            <OlderSessions
              palette={palette}
              count={groups.older.length}
              open={showOlder}
              onPress={() => setShowOlder(!showOlder)}
            />
          )}
          {showOlder ? groups.older.map((session) => row(session, payload.now)) : null}
        </SettingsCard>
      )}

      {payload?.problem ? <Monospace palette={palette} text={payload.problem} /> : null}
      {failure ? <Monospace palette={palette} text={String(failure)} /> : null}

      <Text
        style={{
          color: palette.foregroundMuted,
          fontSize: fontSize.sm,
          lineHeight: leading(fontSize.sm),
          marginLeft: spacing[1],
        }}
      >
        Stopping ends the adapter process holding a session, which closes its Claude terminal without
        closing or archiving the Paseo agent: the next prompt resumes it. A lock names that process.
        The adapter clears its own on exit and recovers one left by a process that has died, so
        releasing by hand is only for a lock that outlived its process and is still in the way.
      </Text>
    </SettingsSection>
  );
}

/**
 * Reveals the agent holding this session. `navigation` is undefined on a host older than 0.7, and a
 * session the daemon no longer lists an agent for has nothing to reveal; both hide the button rather
 * than offering one that does nothing.
 */
function OpenAgent({
  palette,
  navigation,
  agent,
}: {
  palette: Palette;
  navigation: Navigation;
  agent: Session["agent"];
}) {
  if (!navigation || agent === null) return null;
  return (
    <Button palette={palette} label="Open" variant="ghost" onPress={() => navigation.openAgent({ agentId: agent.id })} />
  );
}

/** The one row the cutoff adds, which is also the only way to reach what it collapsed. */
function OlderSessions({
  palette,
  count,
  open,
  onPress,
}: {
  palette: Palette;
  count: number;
  open: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityState={{ expanded: open }}
      style={pressable(({ hovered, pressed }) => ({
        backgroundColor: hovered || pressed ? palette.surface2 : "transparent",
      }))}
    >
      <SettingsRow label={`${open ? "Hide" : "Show"} ${count} older session${count === 1 ? "" : "s"}`} />
    </Pressable>
  );
}

function SessionAction({
  palette,
  session,
  busy,
  stopping,
  onRelease,
  onQuarantine,
  onStop,
}: {
  palette: Palette;
  session: Session;
  busy: boolean;
  stopping: boolean;
  onRelease: () => void;
  onQuarantine: () => void;
  onStop: () => void;
}) {
  if (stopping) {
    return <Text style={{ color: palette.foregroundMuted, fontSize: fontSize.base }}>Stopping…</Text>;
  }
  if (session.corrupt) {
    return (
      <ConfirmButton
        palette={palette}
        label="Move aside"
        confirmLabel="Move it aside"
        detail="Renames the unreadable session file so it stops being read. Nothing that can still be resumed is touched."
        disabled={busy}
        onConfirm={onQuarantine}
      />
    );
  }
  if (session.lock === null) return null;
  if (session.lock.live) {
    return (
      <ConfirmButton
        palette={palette}
        label="Stop"
        confirmLabel="Stop it"
        detail="Ends the adapter process holding this session and closes its Claude terminal. The Paseo agent stays, and the next prompt resumes the conversation."
        disabled={busy}
        onConfirm={onStop}
      />
    );
  }
  return (
    <ConfirmButton
      palette={palette}
      label="Release lock"
      confirmLabel="Release it"
      detail="Deletes a lock whose process is gone. Do this only when the lock is in the way; a live session clears its own."
      disabled={busy}
      onConfirm={onRelease}
    />
  );
}

/** The agent's own title where Paseo still has one, because a cwd names a checkout and not a session. */
function title(session: Session): string {
  return session.agent?.title ?? session.cwd ?? session.id;
}

function reading(session: Session, now: number): Reading {
  if (session.corrupt) return { hint: `${session.id} — unreadable`, tone: "danger" };
  if (session.orphanLock) return { hint: `${session.id} — a lock with no session beside it`, tone: "danger" };
  const held =
    session.lock === null
      ? "not open"
      : session.lock.live
        ? `open in process ${session.lock.pid}`
        : `stale lock from process ${session.lock.pid}`;
  // Ordered by what decides whether to stop a session, because a narrow row loses the tail.
  const parts = [
    held,
    lastActiveLabel(session.lastActivity, now),
    session.model,
    session.mode,
    // Already the title unless the agent named the row.
    typeof session.agent?.title === "string" ? session.cwd : null,
  ];
  return {
    hint: parts.filter((part) => part !== null && part !== "").join(" · "),
    tone: session.lock?.live ? "ok" : session.lock === null ? "muted" : "danger",
  };
}
