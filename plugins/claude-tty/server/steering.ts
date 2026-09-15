import type { ProviderConnection, ProviderEvent, ProviderInput } from "@getpaseo/plugin/server/provider";

/** What a prompt sent while a turn is running asks for, and what the ACP bridge never offers. */
export const STEER_CAPABILITY = "prompt.steer";

/** Nobody reads this: the daemon takes any answer but an accepted steer as a cue to replace the turn. */
const DECLINED = "Claude TTY cannot add a message to a running turn";

/**
 * Gets a message sent during a turn to Claude by the route the daemon keeps for a provider that
 * cannot steer: interrupting the turn and starting a new one with the message.
 *
 * The daemon only takes that route when the provider *answers* a steer. A plugin session attempts one
 * for every message sent mid-turn, and on a session never offered `prompt.steer` the daemon's own
 * capability check throws before anything is sent, so the message is recorded and then lost. The
 * bridge `runAcpProvider` builds cannot steer either — it cancels the running turn before forwarding
 * any prompt, and the adapter refuses a second prompt while one is open — so passing the steer on as
 * an ordinary prompt would end the turn behind the daemon's back and have the daemon replace it again.
 *
 * So the capability is offered and every steer is turned down with a failed result, which the daemon
 * reads as `unavailable` and answers by replacing the turn: what it does for the ACP providers in its
 * own configuration, which have no steering at all.
 */
export function withSteerFallback(connection: ProviderConnection, offered: readonly string[]): ProviderConnection {
  // A daemon that cannot steer never asks, and a bridge that can steer needs none of this.
  if (!offered.includes(STEER_CAPABILITY) || connection.capabilities.includes(STEER_CAPABILITY)) return connection;

  const listeners = new Set<(event: ProviderEvent) => void>();
  let closed = false;

  return {
    version: connection.version,
    capabilities: [...connection.capabilities, STEER_CAPABILITY],
    async send(input: ProviderInput) {
      if (input.type !== "session.prompt" || input.prompt.delivery !== "steer") return connection.send(input);
      if (closed) throw new Error("ACP provider connection is closed");
      const declined: ProviderEvent = {
        type: "session.prompt_result",
        sessionId: input.sessionId,
        clientMessageId: input.prompt.clientMessageId,
        result: { type: "failed", error: { message: DECLINED } },
      };
      // After `send` has returned, which is when the bridge answers every prompt it takes.
      queueMicrotask(() => {
        for (const listener of listeners) listener(declined);
      });
    },
    onEvent(listener: (event: ProviderEvent) => void) {
      listeners.add(listener);
      const unsubscribe = connection.onEvent((event) => listener(offerSteering(event)));
      return () => {
        listeners.delete(listener);
        unsubscribe();
      };
    },
    async close() {
      closed = true;
      listeners.clear();
      await connection.close();
    },
  };
}

/**
 * The daemon checks a prompt against the session's capabilities rather than the connection's, so each
 * session the adapter opens has to carry it too. A child session is prompted by nobody and gets none.
 */
function offerSteering(event: ProviderEvent): ProviderEvent {
  if (event.type !== "session.opened" || event.parentSessionId !== undefined) return event;
  if (event.capabilities.includes(STEER_CAPABILITY)) return event;
  return { ...event, capabilities: [...event.capabilities, STEER_CAPABILITY] };
}
