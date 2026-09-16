import type { AcpTransformer, AcpVendorUpdate } from "@getpaseo/plugin/server/acp";
import type { ProviderConnection, ProviderEvent, ProviderNotice } from "@getpaseo/plugin/server/provider";

/** Mirrors the adapter's own `vendor-updates.ts`; the plugin runs in the daemon and cannot import it. */
export const NOTICE_METHOD = "_claude_tty/notice";
export const CARD_WITHDRAWN_METHOD = "_claude_tty/card_withdrawn";

/** The id `runAcpProvider` gives a permission it raises, which is the only handle both sides share. */
const PERMISSION_ID_PREFIX = "permission:";

const SEVERITIES = new Set<ProviderNotice["severity"]>(["info", "warning", "error"]);

/**
 * The two things the adapter has to say that ACP has no word for.
 *
 * A **notice** is Paseo's own timeline notification -- `session.notice`, an item rather than a message,
 * and no push. It is how something that happened *to* the session gets said: a question of Claude's
 * that had to be dismissed to deliver a prompt, a model Claude switched underneath the session. The
 * bridge has a vendor update for exactly this, so the transformer simply returns one.
 *
 * A **withdrawal** has no such route. ACP permissions are requests the agent waits on, and only the
 * client ever ends one: nothing in the protocol takes a request back, and the bridge clears its pending
 * permissions only when the transport closes. So a question that closed by itself -- Claude times some
 * of its nudges out after 30 seconds -- would leave a card up that answers nothing and nobody can make
 * go away. The plugin resolves it on the daemon's side instead, by emitting the same
 * `session.permission_resolved` the bridge emits when a permission is answered. The bridge goes on
 * holding its own entry for that id, which is why the adapter never reuses one.
 *
 * That event cannot come from a transformer -- an `AcpVendorUpdate` is one of four things and this is
 * none of them -- so it is injected into the connection's own event stream by the wrapper, the way
 * `tool-details.ts` rewrites items on their way out. Both halves are made here together, because the
 * wrapper is what the transformer has to reach to emit anything at all.
 */
export function sessionNotices(): { transformer: AcpTransformer; wrap(connection: ProviderConnection): ProviderConnection } {
  const listeners = new Set<(event: ProviderEvent) => void>();

  return {
    transformer: {
      notification({ method, params }, context): AcpVendorUpdate | null {
        if (method === NOTICE_METHOD) return noticeUpdate(params);
        if (method !== CARD_WITHDRAWN_METHOD) return null;
        const toolCallId = asString(asRecord(params)?.toolCallId);
        if (toolCallId === null) return null;
        for (const listener of listeners) {
          listener({ type: "session.permission_resolved", sessionId: context.sessionId, permissionId: `${PERMISSION_ID_PREFIX}${toolCallId}` });
        }
        return null;
      },
    },
    wrap(connection: ProviderConnection): ProviderConnection {
      return {
        version: connection.version,
        capabilities: connection.capabilities,
        send: (input) => connection.send(input),
        onEvent(listener) {
          listeners.add(listener);
          const unsubscribe = connection.onEvent(listener);
          return () => {
            listeners.delete(listener);
            unsubscribe();
          };
        },
        async close() {
          listeners.clear();
          await connection.close();
        },
      };
    },
  };
}

/** A notice is only worth emitting where the adapter said all of what one needs; anything else is dropped. */
function noticeUpdate(params: unknown): AcpVendorUpdate | null {
  const notice = asRecord(asRecord(params)?.notice);
  const id = asString(notice?.id);
  const title = asString(notice?.title);
  const severity = asString(notice?.severity);
  if (id === null || title === null) return null;
  const description = asString(notice?.description);
  return {
    type: "notice",
    notice: {
      id,
      severity: SEVERITIES.has(severity as ProviderNotice["severity"]) ? (severity as ProviderNotice["severity"]) : "info",
      title,
      ...(description === null ? {} : { description }),
    },
  };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function asString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}
