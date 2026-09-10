import type { PluginSurfaceProps, SettingsState } from "@getpaseo/plugin/client";
import { useRpc, useSettings } from "@getpaseo/plugin/client";
import { SettingsAction, SettingsCard, SettingsRow, SettingsSection, SettingsSelect } from "@getpaseo/plugin/client/ui";
import React, { useEffect, useState } from "react";
import { Text } from "react-native";
import * as contracts from "../shared/contracts.ts";
import type { StatusPayload } from "../shared/contracts.ts";
import { IDLE_TIMEOUT_ENV, IDLE_TIMEOUT_OPTIONS, settingsDocument } from "../shared/settings.ts";
import { fontSize, leading } from "./theme.ts";

type Saved = Extract<SettingsState<typeof settingsDocument.schema>, { status: "ready" }>;

const OPTIONS = IDLE_TIMEOUT_OPTIONS.map((option) => ({ value: String(option.value), label: option.label }));

export function ClaudeTtySettings({ theme }: PluginSurfaceProps) {
  const settings = useSettings(settingsDocument);

  if (settings.status === "loading") {
    return <Note color={theme.colors.foregroundMuted}>Reading the settings…</Note>;
  }
  if (settings.status !== "ready") {
    return (
      <SettingsSection title="Idle sessions">
        <Note color={theme.colors.statusDanger}>{settings.error}</Note>
        <SettingsCard>
          <SettingsAction label="Read them again" actionLabel="Reload" onPress={() => void settings.reload()} />
          {/* Only what is stored can be replaced; a read that never arrived has nothing to reset. */}
          {settings.status === "invalid" ? (
            <SettingsAction label="Restore the default" actionLabel="Reset" onPress={() => void settings.reset()} />
          ) : null}
        </SettingsCard>
      </SettingsSection>
    );
  }
  return <IdleSuspension theme={theme} settings={settings} />;
}

function IdleSuspension({ theme, settings }: { theme: PluginSurfaceProps["theme"]; settings: Saved }) {
  const adapter = useAdapterSettings();
  const override = adapter?.envOverrideMs ?? null;
  const selected = String(settings.values.idleTimeoutMs);
  const options = OPTIONS.some((option) => option.value === selected)
    ? OPTIONS
    : [{ value: selected, label: formatTimeout(settings.values.idleTimeoutMs) }, ...OPTIONS];

  return (
    <SettingsSection title="Idle sessions">
      <SettingsCard>
        <SettingsSelect
          label="Suspend idle Claude"
          hint={
            override === null
              ? "Measured from the end of the last foreground turn"
              : `Overridden: the daemon sets ${IDLE_TIMEOUT_ENV} to ${formatTimeout(override)}`
          }
          error={settings.saveError}
          value={selected}
          options={options}
          disabled={settings.saving}
          onValueChange={(value) => void settings.save({ idleTimeoutMs: Number(value) }, settings.revision)}
        />
        {adapter ? <SettingsRow label="Stored in" hint={adapter.file} /> : null}
      </SettingsCard>
      <Note color={theme.colors.foregroundMuted}>
        Suspension stops the PTY and its background tasks but keeps the logical session. Your next
        prompt resumes the same Claude conversation automatically. The adapter reads this at every
        suspension, so the change applies to open sessions too.
      </Note>
    </SettingsSection>
  );
}

/**
 * Where the document lives and whether the daemon's environment already pins the timeout — neither is
 * in the document, and both change what this screen means. A read that fails costs the two rows and
 * nothing else, so it is not retried or reported: the panel is where this host is diagnosed.
 */
function useAdapterSettings(): StatusPayload["settings"] | null {
  const getStatus = useRpc(contracts.getStatus);
  const [settings, setSettings] = useState<StatusPayload["settings"] | null>(null);
  useEffect(() => {
    let live = true;
    void getStatus({}).then(
      (status) => {
        if (live) setSettings(status.settings);
      },
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, [getStatus]);
  return settings;
}

function Note({ color, children }: { color: string; children: React.ReactNode }) {
  return <Text style={{ color, fontSize: fontSize.sm, lineHeight: leading(fontSize.sm) }}>{children}</Text>;
}

function formatTimeout(milliseconds: number): string {
  if (milliseconds === 0) return "never";
  if (milliseconds % 3_600_000 === 0) {
    const hours = milliseconds / 3_600_000;
    return `${hours} hour${hours === 1 ? "" : "s"}`;
  }
  const minutes = Math.round(milliseconds / 60_000);
  return `${minutes} minute${minutes === 1 ? "" : "s"}`;
}
