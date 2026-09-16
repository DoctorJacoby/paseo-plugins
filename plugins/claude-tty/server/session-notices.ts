import type { AcpTransformer, AcpVendorUpdate } from "@getpaseo/plugin/server/acp";
import type { ProviderConfigState, ProviderConnection, ProviderEvent, ProviderNotice } from "@getpaseo/plugin/server/provider";
import { isDialogPermission } from "./dialog-cards.ts";

/** Mirrors the adapter's own `vendor-updates.ts`; the plugin runs in the daemon and cannot import it. */
export const NOTICE_METHOD = "_claude_tty/notice";
export const CARD_WITHDRAWN_METHOD = "_claude_tty/card_withdrawn";
export const MODEL_CHANGED_METHOD = "_claude_tty/model";

/** The id `runAcpProvider` gives a permission it raises, which is the only handle both sides share. */
const PERMISSION_ID_PREFIX = "permission:";

const SEVERITIES = new Set<ProviderNotice["severity"]>(["info", "warning", "error"]);

/** What the bridge says when a card is answered twice; it has no other way to say it. */
const UNKNOWN_PERMISSION = /Unknown ACP permission/i;

/**
 * The three things the adapter has to say that ACP has no word for.
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
 * A **model change** is the third. Claude can swap the model underneath a running session -- a message
 * its safeguards flag is retried on a fallback model -- and ACP has no update for that: it carries a
 * session's mode home over `current_mode_update` and nothing else about its configuration. The bridge
 * does have a `config` vendor update, but it replaces the whole `ProviderConfigState` rather than
 * patching it, and a transformer is handed no state at all. So the wrapper keeps the last configuration
 * the bridge published for each session, and the change is that snapshot with one field moved. A model
 * the session's own catalogue does not list is ignored rather than shown, because a picker set to an
 * option it does not have is worse than a picker that is one switch out of date.
 */
export function sessionNotices(): { transformer: AcpTransformer; wrap(connection: ProviderConnection): ProviderConnection } {
  const configs = new Map<string, ProviderConfigState>();
  /** The cards the daemon still has open, by the id both sides know them as. */
  const open = new Map<string, { sessionId: string; dialog: boolean }>();
  // The connection the wrapper was given, which is the only thing that can answer a card.
  let inner: ProviderConnection | null = null;

  return {
    transformer: {
      notification({ method, params }, context): AcpVendorUpdate | null {
        if (method === NOTICE_METHOD) return noticeUpdate(params);
        if (method === MODEL_CHANGED_METHOD) return modelUpdate(params, configs.get(context.sessionId));
        if (method !== CARD_WITHDRAWN_METHOD) return null;
        const toolCallId = asString(asRecord(params)?.toolCallId);
        if (toolCallId === null || inner === null) return null;
        withdraw(`${PERMISSION_ID_PREFIX}${toolCallId}`, context.sessionId);
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
            // The configuration the bridge publishes is the only copy of it there is, and the model
            // change below is that copy with one field moved.
            if (event.type === "session.config") configs.set(event.sessionId, event.config);
            if (event.type === "session.permission") {
              const dialog = isDialogPermission(event.request);
              // A session holds one of Claude's questions at a time, so a card for a new one says every
              // older dialog card is over -- whatever became of the withdrawal that should have said so.
              // A card left open is not merely stale: the daemon rebuilds its pending list from the
              // provider's, so it comes back on screen the next time anything is answered.
              if (dialog) {
                for (const [id, card] of open) {
                  if (card.dialog && card.sessionId === event.sessionId && id !== event.request.id) withdraw(id, event.sessionId);
                }
              }
              open.set(event.request.id, { sessionId: event.sessionId, dialog });
            }
            if (event.type === "session.permission_resolved") open.delete(event.permissionId);
            if (event.type === "session.closed" || event.type === "session.runtime_failed") configs.delete(event.sessionId);
            // A withdrawal and a person can answer the same card at the same moment, and the loser of
            // that race is what this is. It says the card was answered twice, not that anything failed.
            if (event.type === "session.runtime_failed" && UNKNOWN_PERMISSION.test(event.error.message)) return;
            listener(event);
          });
        },
        async close() {
          configs.clear();
          open.clear();
          inner = null;
          await connection.close();
        },
      };
    },
  };

  /**
   * Ends a card the way the daemon would: only one that is still open, because answering one that is
   * not is what the bridge reports as the session having failed. Taken off the list first, so the same
   * card is never answered twice from here.
   */
  function withdraw(permissionId: string, sessionId: string): void {
    if (inner === null || !open.delete(permissionId)) return;
    void inner.send({ type: "session.permission", sessionId, permissionId, response: { behavior: "deny" } }).catch(() => undefined);
  }
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

/**
 * The session's configuration with the model Claude switched to in it. Nothing is emitted where there
 * is no configuration to patch yet, or where the model is one this session's catalogue does not offer.
 */
function modelUpdate(params: unknown, config: ProviderConfigState | undefined): AcpVendorUpdate | null {
  const model = asString(asRecord(params)?.model);
  if (model === null || config === undefined) return null;
  if (!config.models.some((entry) => entry.id === model || entry.aliases?.includes(model))) return null;
  if (config.model === model) return null;
  return { type: "config", config: { ...config, model } };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function asString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}
