import type { AcpTransformer, AcpVendorUpdate } from "@getpaseo/plugin/server/acp";
import type { ProviderConnection, ProviderEvent, ProviderNotice } from "@getpaseo/plugin/server/provider";

/** Mirrors the adapter's own `vendor-updates.ts`; the plugin runs in the daemon and cannot import it. */
export const NOTICE_METHOD = "_claude_tty/notice";
export const CARD_WITHDRAWN_METHOD = "_claude_tty/card_withdrawn";

/** The id `runAcpProvider` gives a permission it raises, which is the only handle both sides share. */
const PERMISSION_ID_PREFIX = "permission:";

const SEVERITIES = new Set<ProviderNotice["severity"]>(["info", "warning", "error"]);

/** What the bridge says when a card is answered twice; it has no other way to say it. */
const UNKNOWN_PERMISSION = /Unknown ACP permission/i;

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
 * go away.
 *
 * What ends one properly is the daemon's own answer to it, so that is what the wrapper sends: a
 * `session.permission` input naming the card, with a plain deny. The bridge then does everything it
 * does for a card somebody answered -- it takes the entry out of its pending map, resolves the ACP
 * request, and emits `session.permission_resolved` itself. Emitting only that event was not enough and
 * was measured not to be: the card vanished from `paseo permit ls` and came back as pending the next
 * time a card was raised, because the bridge still held it. The adapter has already stopped waiting for
 * the answer by then, so the reply it gets for that request is dropped where it arrives.
 *
 * The deny lands on the first declining option, which for every card this adapter withdraws is its
 * Dismiss -- and every option on those cards is a declining one anyway.
 *
 * Answering a card that is not pending is not harmless, which is why the cards still open are tracked
 * here: the bridge turns `Unknown ACP permission` into a `session.runtime_failed`, and the daemon reads
 * that as the whole session having fallen over. Tracked from the bridge's own events, so a card a person
 * answered a moment earlier is already gone from the set; the two can still cross, and an
 * `Unknown ACP permission` failure is dropped on the way out because this is the only thing that causes
 * one and it means the card was answered twice, not that the session is broken.
 *
 * The transformer and the wrapper are made here together, because the transformer is what hears the
 * adapter's notification and the wrapper is the only thing that can reach the connection.
 */
export function sessionNotices(): { transformer: AcpTransformer; wrap(connection: ProviderConnection): ProviderConnection } {
  /** The cards the daemon still has open, by the id both sides know them as. */
  const open = new Set<string>();
  // The connection the wrapper was given, which is the only thing that can answer a card.
  let inner: ProviderConnection | null = null;

  return {
    transformer: {
      notification({ method, params }, context): AcpVendorUpdate | null {
        if (method === NOTICE_METHOD) return noticeUpdate(params);
        if (method !== CARD_WITHDRAWN_METHOD) return null;
        const toolCallId = asString(asRecord(params)?.toolCallId);
        if (toolCallId === null || inner === null) return null;
        const permissionId = `${PERMISSION_ID_PREFIX}${toolCallId}`;
        // Only a card that is still open, because answering one that is not is what the bridge reports
        // as the session having failed. Taken out of the set first, so a second withdrawal sends nothing.
        if (!open.delete(permissionId)) return null;
        void inner
          .send({ type: "session.permission", sessionId: context.sessionId, permissionId, response: { behavior: "deny" } })
          .catch(() => undefined);
        return null;
      },
    },
    wrap(connection: ProviderConnection): ProviderConnection {
      inner = connection;
      return {
        version: connection.version,
        capabilities: connection.capabilities,
        send: (input) => connection.send(input),
        onEvent(listener) {
          return connection.onEvent((event) => {
            if (event.type === "session.permission") open.add(event.request.id);
            if (event.type === "session.permission_resolved") open.delete(event.permissionId);
            // A withdrawal and a person can answer the same card at the same moment, and the loser of
            // that race is what this is. It says the card was answered twice, not that anything failed.
            if (event.type === "session.runtime_failed" && UNKNOWN_PERMISSION.test(event.error.message)) return;
            listener(event);
          });
        },
        async close() {
          open.clear();
          inner = null;
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
