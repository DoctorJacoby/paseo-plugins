import type { PluginSurfaceProps } from "@getpaseo/plugin/client";
import { useRpc } from "@getpaseo/plugin/client";
import { SettingsCard, SettingsRow, SettingsSection } from "@getpaseo/plugin/client/ui";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import React, { useCallback } from "react";
import { ScrollView, Text, View } from "react-native";
import * as contracts from "../shared/contracts.ts";
import { PROVIDER_LABEL } from "../shared/provider.ts";
import { DoctorSection } from "./doctor.tsx";
import { SessionsSection } from "./sessions.tsx";
import { SubagentsSection } from "./subagents.tsx";
import { RemoveStateSection } from "./uninstall.tsx";
import { LegacyProviderSection } from "./upgrade.tsx";
import { MAX_CONTENT_WIDTH, fontSize, leading, spacing } from "./theme.ts";
import { Monospace, ReadingRow, adapterReading, claudeReading } from "./status.tsx";
import { usePalette } from "./ui.tsx";

export const STATUS_QUERY_KEY = ["claude-tty", "status"];
const REFETCH_MS = 5_000;

export function ClaudeTtySurface({ theme, layout, navigation }: PluginSurfaceProps) {
  const palette = usePalette(theme);
  const queryClient = useQueryClient();
  const getStatus = useRpc(contracts.getStatus);
  const query = useQuery({
    queryKey: STATUS_QUERY_KEY,
    queryFn: () => getStatus({}),
    refetchInterval: REFETCH_MS,
  });
  const status = query.data ?? null;
  const refreshStatus = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: STATUS_QUERY_KEY });
  }, [queryClient]);

  if (!status) {
    return (
      <View style={{ flex: 1, backgroundColor: palette.surface0, padding: spacing[4] }}>
        <Text style={{ color: palette.foregroundMuted, fontSize: fontSize.base }}>Loading…</Text>
      </View>
    );
  }

  return (
    <ScrollView
      style={{ flex: 1, backgroundColor: palette.surface0 }}
      contentContainerStyle={{
        width: "100%",
        maxWidth: MAX_CONTENT_WIDTH,
        alignSelf: "center",
        padding: layout.compact ? spacing[3] : spacing[4],
        paddingTop: spacing[6],
        paddingBottom: spacing[8],
      }}
    >
      {status.problem === null ? null : (
        <SettingsSection title="Checkout">
          <Monospace palette={palette} text={status.problem} />
          <Text
            style={{
              color: palette.foregroundMuted,
              fontSize: fontSize.sm,
              lineHeight: leading(fontSize.sm),
              marginLeft: spacing[1],
            }}
          >
            This plugin runs the adapter built inside the checkout it was installed from, and finds
            that checkout through the daemon's own record of where it put this plugin.
          </Text>
        </SettingsSection>
      )}

      {status.legacyProvider === null ? null : <LegacyProviderSection palette={palette} legacy={status.legacyProvider} />}

      <SettingsSection title="Adapter">
        <SettingsCard>
          <SettingsRow label="Provider" hint={`Registered by this plugin as "${PROVIDER_LABEL}"`} />
          <ReadingRow palette={palette} title="Executable" reading={adapterReading(status)} />
          <SettingsRow label="Checkout" hint={status.repoRoot ?? "Unknown"} />
        </SettingsCard>
      </SettingsSection>

      <DoctorSection palette={palette} />

      <SessionsSection palette={palette} navigation={navigation} />

      <SubagentsSection palette={palette} />

      <SettingsSection title="This host">
        <SettingsCard>
          <SettingsRow label="Node.js" hint={status.host.node} />
          <ReadingRow palette={palette} title="Claude Code" reading={claudeReading(status)} />
          <SettingsRow label="State directory" hint={status.stateDirectory} />
        </SettingsCard>
        <Text
          style={{
            color: palette.foregroundMuted,
            fontSize: fontSize.sm,
            lineHeight: leading(fontSize.sm),
            marginLeft: spacing[1],
          }}
        >
          Everything here is local to the host running this daemon. Selecting another host in Paseo
          shows that host's own answer.
        </Text>
      </SettingsSection>

      <RemoveStateSection palette={palette} onSettled={refreshStatus} />
    </ScrollView>
  );
}
