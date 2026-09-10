import React from "react";
import { Text, View } from "react-native";
import type { StatusPayload } from "../shared/contracts.ts";
import { MONO_FONT, Row, StatusDot } from "./ui.tsx";
import { fontSize, leading, spacing, type Palette } from "./theme.ts";

export type Tone = "ok" | "muted" | "danger";

export function toneColor(palette: Palette, tone: Tone): string {
  if (tone === "ok") return palette.accent;
  if (tone === "danger") return palette.statusDanger;
  return palette.foregroundMuted;
}

export type Reading = { hint: string; tone: Tone };

export function adapterReading(status: StatusPayload): Reading {
  if (status.adapter.binary === null) return { hint: "No checkout to look in", tone: "danger" };
  return status.adapter.built
    ? { hint: status.adapter.binary, tone: "ok" }
    : { hint: `${status.adapter.binary} is not built — run the build in the checkout`, tone: "danger" };
}

export function claudeReading(status: StatusPayload): Reading {
  return status.host.claude === null
    ? { hint: "Not found — set CLAUDE_BIN, or put it on the daemon's PATH", tone: "danger" }
    : { hint: status.host.claude, tone: "ok" };
}

/** A settings row whose hint is a reading, marked with the dot paseo uses for provider health. */
export function ReadingRow({
  palette,
  title,
  reading,
  divided,
  trailing,
}: {
  palette: Palette;
  title: string;
  reading: Reading;
  divided?: boolean;
  trailing?: React.ReactNode;
}) {
  return (
    <Row
      palette={palette}
      title={title}
      hint={reading.hint}
      hintColor={toneColor(palette, reading.tone)}
      divided={divided}
      trailing={trailing}
      leading={
        <View style={{ paddingRight: spacing[1] }}>
          <StatusDot color={toneColor(palette, reading.tone)} />
        </View>
      }
    />
  );
}

/** Command output and daemon diagnostics, which are read as terminal text or not at all. */
export function Monospace({ palette, text }: { palette: Palette; text: string }) {
  return (
    <View
      style={{
        backgroundColor: palette.surface0,
        borderRadius: 6,
        borderWidth: 1,
        borderColor: palette.border,
        padding: spacing[3],
      }}
    >
      <Text
        selectable
        style={{
          color: palette.foregroundMuted,
          fontFamily: MONO_FONT,
          fontSize: fontSize.sm,
          lineHeight: leading(fontSize.sm),
        }}
      >
        {text}
      </Text>
    </View>
  );
}
