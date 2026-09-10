import type { PluginTheme } from "@getpaseo/plugin";
import { Icon } from "@getpaseo/plugin/client/react-native";
import { SettingsCard } from "@getpaseo/plugin/client/ui";
import type { StyleProp, ViewStyle } from "react-native";
import React, { useMemo, useState } from "react";
import { Platform, Pressable, Text, View } from "react-native";
import { controlHeight, derivePalette, fontSize, iconSize, radius, spacing, type Palette } from "./theme.ts";

export function usePalette(theme: PluginTheme): Palette {
  const colors = theme.colors;
  return useMemo(
    () => derivePalette(theme),
    [
      colors.surface0,
      colors.surface1,
      colors.surface2,
      colors.border,
      colors.foreground,
      colors.foregroundMuted,
      colors.accent,
      colors.accentForeground,
      colors.statusSuccess,
      colors.statusWarning,
      colors.statusDanger,
    ],
  );
}

/**
 * React Native types a pressable's style callback without `hovered`, which the web renderer does pass
 * and which every paseo control styles itself with.
 */
export type PressState = { pressed: boolean; hovered?: boolean };

export function pressable(
  style: (state: PressState) => StyleProp<ViewStyle>,
): (state: { pressed: boolean }) => StyleProp<ViewStyle> {
  return style as (state: { pressed: boolean }) => StyleProp<ViewStyle>;
}

export type ButtonVariant = "default" | "outline" | "ghost";

/** The host's settings rows carry their own button; this is the one for everywhere else. */
export function Button({
  palette,
  label,
  onPress,
  disabled,
  variant = "outline",
}: {
  palette: Palette;
  label: string;
  onPress: () => void;
  disabled?: boolean;
  variant?: ButtonVariant;
}) {
  const surface = {
    default: { backgroundColor: palette.accent, borderColor: palette.accent },
    outline: { backgroundColor: "transparent", borderColor: palette.borderAccent },
    ghost: { backgroundColor: "transparent", borderColor: "transparent" },
  }[variant];
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="button"
      style={pressable(({ hovered, pressed }) => [
        {
          minHeight: controlHeight.compact,
          paddingHorizontal: spacing[3],
          borderRadius: radius.md,
          borderWidth: 1,
          alignItems: "center",
          justifyContent: "center",
          opacity: disabled ? 0.5 : pressed ? 0.85 : 1,
        },
        surface,
        variant !== "default" && (hovered || pressed) ? { backgroundColor: palette.surface2 } : null,
      ])}
    >
      <Text style={{ color: variant === "default" ? palette.accentForeground : palette.foreground, fontSize: fontSize.base }}>
        {label}
      </Text>
    </Pressable>
  );
}

/**
 * A card that opens on its header row, for settings that most installs never touch. The host has no
 * disclosure of its own; the divider between the header and the body is the card's, which draws one
 * between children and so only while this is open.
 */
export function Disclosure({
  palette,
  title,
  summary,
  initialOpen = false,
  children,
}: {
  palette: Palette;
  title: string;
  summary?: string;
  initialOpen?: boolean;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(initialOpen);
  return (
    <SettingsCard>
      <Pressable
        onPress={() => setOpen(!open)}
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        style={pressable(({ hovered, pressed }) => ({
          flexDirection: "row",
          alignItems: "center",
          gap: spacing[2],
          paddingVertical: spacing[4],
          paddingHorizontal: spacing[4],
          backgroundColor: hovered || pressed ? palette.surface2 : "transparent",
        }))}
      >
        <Icon
          name={open ? "ChevronDown" : "ChevronRight"}
          size={iconSize.sm}
          color={palette.foregroundMuted}
        />
        <Text style={{ flex: 1, color: palette.foreground, fontSize: fontSize.base }}>{title}</Text>
        {summary ? (
          <Text numberOfLines={1} style={{ color: palette.foregroundMuted, fontSize: fontSize.sm }}>
            {summary}
          </Text>
        ) : null}
      </Pressable>
      {open ? <View>{children}</View> : null}
    </SettingsCard>
  );
}

export function StatusDot({ color, size = 8 }: { color: string; size?: number }) {
  return <View style={{ width: size, height: size, borderRadius: size / 2, backgroundColor: color }} />;
}

export const MONO_FONT =
  Platform.select({
    ios: "Menlo",
    android: "monospace",
    default: "SFMono-Regular, Menlo, Monaco, Consolas, 'Liberation Mono', 'Courier New', monospace",
  }) ?? "monospace";
