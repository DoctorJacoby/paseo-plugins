import { useRpc } from "@getpaseo/plugin/client";
import { SettingsCard, SettingsRow, SettingsSection } from "@getpaseo/plugin/client/ui";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import React from "react";
import { Text, View } from "react-native";
import * as contracts from "../shared/contracts.ts";
import type { DoctorPayload } from "../shared/contracts.ts";
import { fontSize, leading, spacing, type Palette } from "./theme.ts";
import { Monospace, ReadingRow } from "./status.tsx";
import { Button } from "./ui.tsx";

export const DOCTOR_QUERY_KEY = ["claude-tty", "doctor"];

export function DoctorSection({ palette }: { palette: Palette }) {
  const queryClient = useQueryClient();
  const getDoctor = useRpc(contracts.getDoctor);
  const runDoctor = useRpc(contracts.runDoctor);
  const query = useQuery({ queryKey: DOCTOR_QUERY_KEY, queryFn: () => getDoctor({}) });
  const run = useMutation({
    mutationFn: () => runDoctor({}),
    onSuccess: (next) => queryClient.setQueryData(DOCTOR_QUERY_KEY, next),
  });
  const report = query.data ?? null;

  return (
    <SettingsSection
      title="Diagnostics"
      trailing={
        <Button
          palette={palette}
          label={run.isPending ? "Running…" : "Run"}
          disabled={run.isPending}
          onPress={() => run.mutate()}
        />
      }
    >
      {report === null ? (
        <Text
          style={{
            color: run.error ? palette.statusDanger : palette.foregroundMuted,
            fontSize: fontSize.sm,
            lineHeight: leading(fontSize.sm),
            marginLeft: spacing[1],
          }}
        >
          {run.error
            ? String(run.error)
            : "Runs the configured adapter's own host checks, and asks Paseo what it sees when it launches the provider."}
        </Text>
      ) : (
        <DoctorReport palette={palette} report={report} />
      )}
    </SettingsSection>
  );
}

function DoctorReport({ palette, report }: { palette: Palette; report: DoctorPayload }) {
  return (
    <View style={{ gap: spacing[4] }}>
      <SettingsCard>
        <SettingsRow label="Executable" hint={report.adapter.binary ?? "No checkout to look in"} />
        {report.adapter.checks.map((check) => (
          <ReadingRow
            key={check.id}
            palette={palette}
            title={check.label}
            reading={{ hint: check.detail, tone: check.ok ? "ok" : "danger" }}
          />
        ))}
      </SettingsCard>

      {report.adapter.problem === null ? null : <Monospace palette={palette} text={report.adapter.problem} />}
    </View>
  );
}

