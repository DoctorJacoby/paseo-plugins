import type { PluginSurfaceProps, SettingsState } from "@getpaseo/plugin/client";
import { useRpc, useSettings } from "@getpaseo/plugin/client";
import { SettingsAction, SettingsCard, SettingsInput, SettingsRow, SettingsSection, SettingsSelect, SettingsSwitch } from "@getpaseo/plugin/client/ui";
import React, { useEffect, useState } from "react";
import { Text } from "react-native";
import * as contracts from "../shared/contracts.ts";
import type { StatusPayload } from "../shared/contracts.ts";
import { BYPASS_AUTO_ACCEPT_OPTIONS, IDLE_TIMEOUT_ENV, IDLE_TIMEOUT_OPTIONS, settingsDocument } from "../shared/settings.ts";
import { adapterReading } from "./status.tsx";
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
      <SettingsSection title="Settings">
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
  return (
    <>
      <Adapter theme={theme} settings={settings} />
      <IdleSuspension theme={theme} settings={settings} />
      <PermissionPrompts theme={theme} settings={settings} />
    </>
  );
}

/**
 * The one setting that can be wrong in a way the store cannot see: it holds a path, and whether a
 * path names something runnable is a question about the host rather than about the value. So it is
 * saved as typed and read back from the status the panel reports, which is the side that looked.
 */
function Adapter({ theme, settings }: { theme: PluginSurfaceProps["theme"]; settings: Saved }) {
  const saved = settings.values.adapterExecutable;
  const status = useStatus(saved);
  const reading = status === null ? null : adapterReading(status);
  // `onChangeText` is every keystroke, and each save is a document the provider reads, so the text
  // is held here and committed on purpose rather than written a character at a time.
  const [typed, setTyped] = useState(saved);

  return (
    <SettingsSection title="Adapter">
      <SettingsCard>
        <SettingsInput
          label="Adapter executable"
          hint="Leave empty to run the adapter in the checkout this plugin was installed from"
          error={settings.saveError ?? (reading?.tone === "danger" ? reading.hint : undefined)}
          initialValue={saved}
          placeholder="/path/to/paseo-plugins/apps/claude-tty-acp/bin/claude-tty-acp"
          disabled={settings.saving}
          onChangeText={setTyped}
        />
        <SettingsAction
          label="Use this adapter"
          actionLabel={settings.saving ? "Saving…" : "Save"}
          disabled={settings.saving || typed === saved}
          onPress={() => void settings.save({ ...settings.values, adapterExecutable: typed }, settings.revision)}
        />
        {reading?.tone === "ok" ? <SettingsRow label="Running" hint={reading.hint} /> : null}
      </SettingsCard>
      <Note color={theme.colors.foregroundMuted}>
        The adapter is a native build with no published artefact, so it is built from a clone of the
        plugin repository — `pnpm install --frozen-lockfile` and `pnpm --filter
        @paseo-plugins/claude-tty-acp build` — and this is where that build is pointed at. Sessions
        already open keep the adapter they started on; the next one started uses this.
      </Note>
    </SettingsSection>
  );
}

function IdleSuspension({ theme, settings }: { theme: PluginSurfaceProps["theme"]; settings: Saved }) {
  const adapter = useStatus()?.settings ?? null;
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
          onValueChange={(value) => void settings.save({ ...settings.values, idleTimeoutMs: Number(value) }, settings.revision)}
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

function PermissionPrompts({ theme, settings }: { theme: PluginSurfaceProps["theme"]; settings: Saved }) {
  return (
    <SettingsSection title="Permission prompts">
      <SettingsCard>
        <SettingsSwitch
          label="Auto-accept in new sessions"
          hint="Where each agent's Auto Accept toggle starts"
          error={settings.saveError}
          value={settings.values.autoAccept}
          disabled={settings.saving}
          onValueChange={(value) => void settings.save({ ...settings.values, autoAccept: value }, settings.revision)}
        />
        <SettingsSelect
          label="In Bypass Permissions sessions"
          hint="Overrides the switch above for sessions in that mode"
          value={settings.values.bypassAutoAccept}
          options={BYPASS_AUTO_ACCEPT_OPTIONS}
          disabled={settings.saving}
          onValueChange={(value) => void settings.save({ ...settings.values, bypassAutoAccept: value }, settings.revision)}
        />
      </SettingsCard>
      <Note color={theme.colors.foregroundMuted}>
        Auto Accept approves Claude Code's permission prompts without showing a card, including the
        removals of critical paths that Claude Code asks about even in Bypass Permissions mode. Questions
        and plans still wait for you. An agent you switch by hand keeps its own value; every other agent
        reads these again at each permission prompt, so a change here applies to open sessions too.
      </Note>
    </SettingsSection>
  );
}

/**
 * What this screen cannot see for itself: where the host keeps the document, whether the daemon's
 * environment already pins the timeout, and what became of the adapter path saved here. A read that
 * fails costs those readings and nothing else, so it is not retried or reported: the panel is where
 * this host is diagnosed.
 *
 * `after` is whatever has to have been saved before the answer is worth having again — the store
 * writes its file before it answers a save, and the server reads that file, so a value that has
 * reached this component has reached the daemon too.
 */
function useStatus(after?: string): StatusPayload | null {
  const getStatus = useRpc(contracts.getStatus);
  const [status, setStatus] = useState<StatusPayload | null>(null);
  useEffect(() => {
    let live = true;
    void getStatus({}).then(
      (next) => {
        if (live) setStatus(next);
      },
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, [getStatus, after]);
  return status;
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
