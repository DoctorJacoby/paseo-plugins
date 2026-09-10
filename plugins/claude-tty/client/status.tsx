import { Icon, copyText, useToast } from "@getpaseo/plugin/client/react-native";
import { SettingsRow } from "@getpaseo/plugin/client/ui";
import React from "react";
import { Pressable, Text, View } from "react-native";
import type { StatusPayload } from "../shared/contracts.ts";
import { MONO_FONT, StatusDot, pressable } from "./ui.tsx";
import { fontSize, iconSize, leading, radius, spacing, type Palette } from "./theme.ts";

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

/**
 * A settings row whose hint is a reading. A bad one goes in the host row's `error`, which is where it
 * is coloured and announced; the dot beside the control is what separates a good reading from one
 * that is merely inert.
 */
export function ReadingRow({
  palette,
  title,
  reading,
  trailing,
}: {
  palette: Palette;
  title: string;
  reading: Reading;
  trailing?: React.ReactNode;
}) {
  return (
    <SettingsRow
      label={title}
      hint={reading.tone === "danger" ? undefined : reading.hint}
      error={reading.tone === "danger" ? reading.hint : undefined}
    >
      <View style={{ flexDirection: "row", alignItems: "center", gap: spacing[3] }}>
        <StatusDot color={toneColor(palette, reading.tone)} />
        {trailing}
      </View>
    </SettingsRow>
  );
}

/** Command output and daemon diagnostics, which are read as terminal text or not at all. */
export function Monospace({ palette, text }: { palette: Palette; text: string }) {
  const toast = useToast();
  // Selecting a wrapped stack trace by hand on a phone is the alternative, so the copy is worth a button.
  const copy = async (): Promise<void> => {
    try {
      await copyText(text);
      toast.show("Copied", { variant: "success" });
    } catch {
      toast.error("Could not copy. Select the text and use Copy.");
    }
  };

  return (
    <View
      style={{
        backgroundColor: palette.surface0,
        borderRadius: radius.md,
        borderWidth: 1,
        borderColor: palette.border,
        padding: spacing[3],
        flexDirection: "row",
        alignItems: "flex-start",
        gap: spacing[2],
      }}
    >
      <Text
        selectable
        style={{
          flex: 1,
          color: palette.foregroundMuted,
          fontFamily: MONO_FONT,
          fontSize: fontSize.sm,
          lineHeight: leading(fontSize.sm),
        }}
      >
        {text}
      </Text>
      <Pressable
        onPress={() => void copy()}
        accessibilityRole="button"
        accessibilityLabel="Copy this text"
        hitSlop={8}
        style={pressable(({ hovered, pressed }) => ({ opacity: hovered || pressed ? 1 : 0.6 }))}
      >
        <Icon name="Copy" size={iconSize.sm} color={palette.foregroundMuted} />
      </Pressable>
    </View>
  );
}
