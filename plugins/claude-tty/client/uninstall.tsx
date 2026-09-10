import { useRpc } from "@getpaseo/plugin/client";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import React from "react";
import { Text, View } from "react-native";
import * as contracts from "../shared/contracts.ts";
import { fontSize, leading, spacing, type Palette } from "./theme.ts";
import { ConfirmButton } from "./confirm.tsx";
import { Monospace } from "./status.tsx";
import { Disclosure } from "./ui.tsx";

export function RemoveStateSection({ palette, onSettled }: { palette: Palette; onSettled: () => void }) {
  const queryClient = useQueryClient();
  const removeState = useRpc(contracts.removeState);
  const remove = useMutation({
    mutationFn: () => removeState({}),
    onSuccess: () => {
      void queryClient.invalidateQueries();
      onSettled();
    },
  });

  return (
    <Disclosure palette={palette} title="Danger zone" summary="Delete the saved sessions">
      <View style={{ padding: spacing[4], gap: spacing[3] }}>
        <Text style={{ color: palette.foregroundMuted, fontSize: fontSize.sm, lineHeight: leading(fontSize.sm) }}>
          Deletes the state directory, so no agent resumes the Claude conversation it was holding.
          Refused while a session is open. Claude's own configuration, credentials and transcripts
          are never touched, and taking the provider away is "paseo plugin remove claude-tty" rather
          than anything here.
        </Text>
        <View style={{ flexDirection: "row", justifyContent: "flex-end" }}>
          <ConfirmButton
            palette={palette}
            label="Delete the saved sessions"
            confirmLabel="Delete them"
            disabled={remove.isPending}
            onConfirm={() => remove.mutate()}
          />
        </View>
        {remove.error ? <Monospace palette={palette} text={String(remove.error)} /> : null}
        {remove.data ? <Monospace palette={palette} text={remove.data.detail} /> : null}
      </View>
    </Disclosure>
  );
}
