import { useRpc } from "@getpaseo/plugin/client";
import { SettingsCard, SettingsRow, SettingsSection } from "@getpaseo/plugin/client/ui";
import { useQuery } from "@tanstack/react-query";
import React from "react";
import { Text, View } from "react-native";
import * as contracts from "../shared/contracts.ts";
import type { SubagentsPayload } from "../shared/contracts.ts";
import { lastStepLabel } from "../shared/subagents.ts";
import { fontSize, leading, spacing, type Palette } from "./theme.ts";
import { Monospace } from "./status.tsx";
import { Disclosure, MONO_FONT } from "./ui.tsx";

export const SUBAGENTS_QUERY_KEY = ["claude-tty", "subagents"];
const REFETCH_MS = 5_000;

type Subagent = SubagentsPayload["sessions"][number]["subagents"][number];
type TranscriptStep = contracts.SubagentTranscriptPayload["steps"][number];

export function SubagentsSection({ palette }: { palette: Palette }) {
  const getSubagents = useRpc(contracts.getSubagents);
  const query = useQuery({
    queryKey: SUBAGENTS_QUERY_KEY,
    queryFn: () => getSubagents({}),
    refetchInterval: REFETCH_MS,
  });
  const payload = query.data ?? null;

  return (
    <SettingsSection title="Subagents">
      {payload === null ? null : payload.sessions.length === 0 ? (
        <SettingsCard>
          <SettingsRow label="No subagents" hint="Nothing has been launched in the open sessions" />
        </SettingsCard>
      ) : (
        payload.sessions.map((session) => (
          <View key={session.sessionId} style={{ gap: spacing[2] }}>
            {payload.sessions.length > 1 ? (
              <Text numberOfLines={1} style={{ color: palette.foregroundMuted, fontSize: fontSize.sm, marginLeft: spacing[1] }}>
                {session.cwd ?? session.sessionId}
              </Text>
            ) : null}
            {session.subagents.map((subagent) => (
              <Disclosure
                key={subagent.agentId}
                palette={palette}
                title={subagent.description ?? subagent.agentId}
                summary={summary(subagent, payload.now)}
              >
                <SubagentSteps palette={palette} sessionId={session.sessionId} subagent={subagent} />
              </Disclosure>
            ))}
          </View>
        ))
      )}

      {payload?.problem ? <Monospace palette={palette} text={payload.problem} /> : null}

      <Text
        style={{
          color: palette.foregroundMuted,
          fontSize: fontSize.sm,
          lineHeight: leading(fontSize.sm),
          marginLeft: spacing[1],
        }}
      >
        Claude keeps a transcript for every subagent it runs, and the session's own transcript says
        only that one was launched. These are read from those files, so a subagent shows its work here
        and in the tool call that launched it. Only open sessions are listed: a subagent runs inside
        its session's Claude process and stops with it.
      </Text>
    </SettingsSection>
  );
}

function SubagentSteps({
  palette,
  sessionId,
  subagent,
}: {
  palette: Palette;
  sessionId: string;
  subagent: Subagent;
}) {
  const readSubagent = useRpc(contracts.readSubagent);
  const query = useQuery({
    queryKey: [...SUBAGENTS_QUERY_KEY, sessionId, subagent.agentId],
    queryFn: () => readSubagent({ sessionId, agentId: subagent.agentId }),
    // A finished subagent writes nothing more, so only a running one is worth asking about again.
    refetchInterval: subagent.status === "running" ? REFETCH_MS : false,
  });

  if (query.error) return <Note palette={palette} text={String(query.error)} />;
  if (!query.data) return <Note palette={palette} text="Reading…" />;
  if (query.data.steps.length === 0) return <Note palette={palette} text="Nothing in its transcript yet." />;

  return (
    <View style={{ paddingVertical: spacing[3], paddingHorizontal: spacing[4], gap: spacing[3] }}>
      {subagent.summary ? (
        <Text style={{ color: palette.foreground, fontSize: fontSize.sm, lineHeight: leading(fontSize.sm) }}>
          {subagent.summary}
        </Text>
      ) : null}
      {query.data.earlier > 0 ? (
        <Note palette={palette} text={`… ${query.data.earlier} earlier step${query.data.earlier === 1 ? "" : "s"}`} />
      ) : null}
      {query.data.steps.map((step, index) => (
        <Step key={index} palette={palette} step={step} startedAt={query.data.startedAt} />
      ))}
    </View>
  );
}

/**
 * One step, with the time it happened held in a gutter of its own. What a subagent says and what it
 * runs read differently on purpose: the words are prose, and a command is shown as it was written.
 */
function Step({ palette, step, startedAt }: { palette: Palette; step: TranscriptStep; startedAt: number | null }) {
  const tone = step.failed ? palette.statusDanger : palette.foreground;
  return (
    <View style={{ flexDirection: "row", gap: spacing[3] }}>
      <Text
        style={{
          width: 46,
          textAlign: "right",
          color: palette.foregroundExtraMuted,
          fontFamily: MONO_FONT,
          fontSize: fontSize.sm,
          lineHeight: leading(fontSize.sm),
        }}
      >
        {elapsedLabel(step.at, startedAt)}
      </Text>
      <View style={{ flex: 1, gap: spacing[1] }}>
        {step.kind === "text" ? (
          <Text style={{ color: palette.foreground, fontSize: fontSize.sm, lineHeight: leading(fontSize.sm) }}>{step.title}</Text>
        ) : (
          <Text style={{ fontSize: fontSize.sm, lineHeight: leading(fontSize.sm) }}>
            <Text style={{ color: tone, fontFamily: MONO_FONT }}>{step.title}</Text>
            {step.detail ? <Text style={{ color: palette.foregroundMuted }}>{`  ${step.detail}`}</Text> : null}
          </Text>
        )}
        {step.body ? (
          <Text
            numberOfLines={3}
            style={{
              color: palette.foregroundMuted,
              fontFamily: MONO_FONT,
              fontSize: fontSize.sm,
              lineHeight: leading(fontSize.sm),
            }}
          >
            {step.body}
          </Text>
        ) : null}
        {step.error ? (
          <Text
            numberOfLines={2}
            style={{
              color: palette.statusDanger,
              fontFamily: MONO_FONT,
              fontSize: fontSize.sm,
              lineHeight: leading(fontSize.sm),
            }}
          >
            {step.error}
          </Text>
        ) : null}
      </View>
    </View>
  );
}

function Note({ palette, text }: { palette: Palette; text: string }) {
  return (
    <View style={{ paddingVertical: spacing[3], paddingHorizontal: spacing[4] }}>
      <Text style={{ color: palette.foregroundMuted, fontSize: fontSize.sm, lineHeight: leading(fontSize.sm) }}>{text}</Text>
    </View>
  );
}

/** How far into the run a step happened, which is the only reading that survives another timezone. */
function elapsedLabel(at: number | null, startedAt: number | null): string {
  if (at === null || startedAt === null || at < startedAt) return "";
  const seconds = Math.floor((at - startedAt) / 1_000);
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

function summary(subagent: Subagent, now: number): string {
  const state =
    subagent.status === "unknown" ? "launch no longer in the transcript" : subagent.status;
  return [state, subagent.nested ? "nested" : null, lastStepLabel(subagent.lastActivity, now)]
    .filter((part) => part !== null)
    .join(" · ");
}
