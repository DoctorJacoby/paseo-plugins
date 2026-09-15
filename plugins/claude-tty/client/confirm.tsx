import { Icon, Modal } from "@getpaseo/plugin/client/react-native";
import React, { useState } from "react";
import { Text, View } from "react-native";
import { fontSize, iconSize, leading, spacing, type Palette } from "./theme.ts";
import { Button } from "./ui.tsx";

/**
 * Every destructive action here ends a session or deletes state, so it asks first. The host owns the
 * dialog: a bottom sheet on a phone, a centred dialog otherwise, dismissed by the backdrop, Escape or
 * the platform back action, all of which arrive as `onOpenChange(false)`.
 */
export function ConfirmButton({
  palette,
  label,
  confirmLabel,
  detail,
  disabled,
  onConfirm,
}: {
  palette: Palette;
  label: string;
  confirmLabel: string;
  /** What the action does, in the words the panel would otherwise have to print beside the button. */
  detail?: string;
  disabled?: boolean;
  onConfirm: () => void;
}) {
  const [open, setOpen] = useState(false);

  return (
    <View>
      <Button palette={palette} label={label} disabled={disabled} onPress={() => setOpen(true)} />
      <Modal
        title={label}
        icon={<Icon name="TriangleAlert" size={iconSize.md} color={palette.statusWarning} />}
        open={open}
        onOpenChange={setOpen}
      >
        <Modal.Content>
          {detail ? (
            <Text style={{ color: palette.foregroundMuted, fontSize: fontSize.base, lineHeight: leading(fontSize.base) }}>
              {detail}
            </Text>
          ) : null}
          <View style={{ flexDirection: "row", justifyContent: "flex-end", gap: spacing[2] }}>
            <Button palette={palette} label="Cancel" variant="ghost" onPress={() => setOpen(false)} />
            <Button
              palette={palette}
              label={confirmLabel}
              variant="default"
              disabled={disabled}
              onPress={() => {
                setOpen(false);
                onConfirm();
              }}
            />
          </View>
        </Modal.Content>
      </Modal>
    </View>
  );
}
