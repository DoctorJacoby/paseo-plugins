import { SettingsCard, SettingsRow, SettingsSection } from "@getpaseo/plugin/client/ui";
import React from "react";
import { Text } from "react-native";
import type { StatusPayload } from "../shared/contracts.ts";
import { PROVIDER_ID } from "../shared/provider.ts";
import { fontSize, leading, spacing, type Palette } from "./theme.ts";
import { ReadingRow, type Reading } from "./status.tsx";

type LegacyProvider = NonNullable<StatusPayload["legacyProvider"]>;

export function legacyAgentsReading(legacy: LegacyProvider): Reading {
  if (legacy.agents === null) return { hint: "Paseo did not list its agents in time to count them", tone: "muted" };
  if (legacy.agents === 0) return { hint: "None, so it can be removed", tone: "ok" };
  const subject = legacy.agents === 1 ? "1 agent is" : `${legacy.agents} agents are`;
  return { hint: `${subject} still on it, and cannot resume once it is gone`, tone: "muted" };
}

/**
 * Only there while the daemon configuration still holds the adapter's entry from before this plugin
 * owned the provider. The plugin never removes it itself, so this says how, and when it is safe to.
 */
export function LegacyProviderSection({ palette, legacy }: { palette: Palette; legacy: LegacyProvider }) {
  return (
    <SettingsSection title="Left over from an older install">
      <SettingsCard>
        <SettingsRow label={`Provider "${legacy.id}"`} hint={legacy.command} />
        <ReadingRow palette={palette} title="Agents on it" reading={legacyAgentsReading(legacy)} />
      </SettingsCard>
      <Text
        style={{
          color: palette.foregroundMuted,
          fontSize: fontSize.sm,
          lineHeight: leading(fontSize.sm),
          marginLeft: spacing[1],
        }}
      >
        Paseo lists Claude TTY twice until this entry is gone. Once no agent is left on it, remove it
        under Settings → Providers on this host: it is the Claude TTY entry with an actions menu. New
        agents belong on this plugin's provider, so anything that names "{legacy.id}/&lt;model&gt;" has
        to name "{PROVIDER_ID}/&lt;model&gt;" instead.
      </Text>
    </SettingsSection>
  );
}
