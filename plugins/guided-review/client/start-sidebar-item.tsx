import type { PluginSidebarItemProps } from "@getpaseo/plugin/client";
import { useRpc } from "@getpaseo/plugin/client";
import { SidebarRow } from "@getpaseo/plugin/client/ui";
import { useQuery } from "@tanstack/react-query";
import React from "react";
import { Text } from "react-native";
import * as contracts from "../shared/contracts.ts";
import { PLUGIN_ICON, START_SCREEN_ID } from "../shared/identity.ts";
import { INBOX_QUERY_KEY } from "./check-off.ts";
import { attentionCount } from "./inbox-filter.ts";
import { fontSize, leading } from "./theme.ts";

/**
 * The row that opens the start screen, with how many listed reviews need the reviewer's attention.
 * It reads the review list's own query and lists only while nothing is cached, since a listing runs every forge's searches: the count moves when the list is listed again or a row is checked off.
 */
export function StartSidebarItem({ theme, currentScreen, openScreen }: PluginSidebarItemProps) {
  const getInbox = useRpc(contracts.getInbox);
  const inbox = useQuery({ queryKey: INBOX_QUERY_KEY, queryFn: () => getInbox({}), staleTime: Infinity, refetchOnWindowFocus: false });
  const count = inbox.data ? attentionCount(inbox.data) : 0;

  return (
    <SidebarRow
      icon={PLUGIN_ICON}
      active={currentScreen?.screenId === START_SCREEN_ID}
      onPress={() => openScreen({ screenId: START_SCREEN_ID })}
      trailing={
        count > 0 ? (
          <Text
            accessibilityLabel={`${count} ${count === 1 ? "review needs" : "reviews need"} your attention`}
            style={{ color: theme.colors.foregroundMuted, fontSize: fontSize.sm, lineHeight: leading(fontSize.sm), fontVariant: ["tabular-nums"] }}
          >
            {count}
          </Text>
        ) : null
      }
    />
  );
}
