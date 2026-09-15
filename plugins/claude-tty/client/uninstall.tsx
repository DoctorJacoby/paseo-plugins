import { useRpc } from "@getpaseo/plugin/client";
import { useToast } from "@getpaseo/plugin/client/react-native";
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
  const toast = useToast();
  const removeState = useRpc(contracts.removeState);
  const remove = useMutation({
    mutationFn: () => removeState({}),
    onSuccess: (result) => {
      toast.show(result.detail, { variant: "success" });
      void queryClient.invalidateQueries();
      onSettled();
    },
    // A refusal is the expected answer while a session is open, and it says why, so it is kept on
    // screen as well: a toast is gone before the sentence has been read.
    onError: (error) => toast.error(String(error)),
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
            detail="Every saved session goes, so no agent can resume the Claude conversation it was holding. Claude's own configuration, credentials and transcripts are untouched."
            disabled={remove.isPending}
            onConfirm={() => remove.mutate()}
          />
        </View>
        {remove.error ? <Monospace palette={palette} text={String(remove.error)} /> : null}
      </View>
    </Disclosure>
  );
}
