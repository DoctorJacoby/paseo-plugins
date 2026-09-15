import type { ProviderConnection, ProviderEvent, ProviderInput, ProviderTimelineItem } from "@getpaseo/plugin/server/provider";

/**
 * Gives a cancelled tool call the outcome the daemon's own schema has for one.
 *
 * A `failed` tool call has to carry a non-null error — `ToolCallFailedPayloadSchema` requires one —
 * and one that carries null is not merely dropped: the whole `fetch_agent_timeline_response` fails
 * validation, so the client refuses the *entire* history of that agent and goes on refusing it for
 * as long as the item is in the timeline. It reads as "Couldn't refresh agent history", with nothing
 * logged anywhere, on a session that is otherwise working perfectly.
 *
 * The bridge makes one on every cancelled turn. `terminalizeTransientItems` is handed `canceled` or
 * `completed` and maps anything that is not `completed` to `failed`, and the failed item takes its
 * error from the tool call's output — which a call that was still running never wrote. Paseo cancels
 * a turn before it replaces one, and a message sent while a subagent runs arrives as exactly that,
 * so in a session with background work this is one message away at any time.
 *
 * `canceled` is what the bridge had and threw away, and the schema takes it with a null error. A
 * genuine failure always carries its output as its error, so a failed call with none did not fail:
 * it was still running when its turn ended.
 */
export function withCancelledToolCalls(connection: ProviderConnection): ProviderConnection {
  return {
    version: connection.version,
    capabilities: connection.capabilities,
    async send(input: ProviderInput) {
      return connection.send(input);
    },
    onEvent(listener: (event: ProviderEvent) => void) {
      return connection.onEvent((event) => listener(asCancelled(event)));
    },
    async close() {
      await connection.close();
    },
  };
}

function asCancelled(event: ProviderEvent): ProviderEvent {
  if (event.type !== "timeline.item") return event;
  const item: ProviderTimelineItem = event.item;
  if (item.type !== "tool_call" || item.status !== "failed" || item.error !== null) return event;
  return { ...event, item: { ...item, status: "canceled", error: null } };
}
