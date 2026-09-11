import type {
  ProviderConnection,
  ProviderEvent,
  ProviderInput,
  ProviderPermissionRequest,
  ProviderPermissionResponse,
} from "@getpaseo/plugin/server/provider";
import { writeCardAnswers } from "./card-answers.ts";
import { answersByQuestion, planPermission, questionPermission, SUBMIT_OPTION_ID } from "./question-cards.ts";

/** The id `runAcpProvider` gives a permission it raises for a tool call, which is the only handle both sides share. */
const PERMISSION_ID_PREFIX = "permission:";

/**
 * Everything the ACP bridge cannot say. It builds every permission as a plain `kind: "tool"` card
 * with one button per ACP option, because ACP has nowhere to put the rest; the two tools that ask a
 * person something have a card of Paseo's own, so their requests are rebuilt on the way out here.
 * On the way back the same wrapper takes the answers off the response, which the bridge would
 * otherwise drop, and leaves them where the adapter reads them.
 */
export function withPermissionCards(connection: ProviderConnection, answersDirectory: string): ProviderConnection {
  const cards = new Map<string, ProviderPermissionRequest>();
  return {
    version: connection.version,
    capabilities: connection.capabilities,
    async send(input: ProviderInput) {
      if (input.type !== "session.permission") return connection.send(input);
      const card = cards.get(input.permissionId);
      if (!card) return connection.send(input);
      cards.delete(input.permissionId);
      return connection.send({ ...input, response: await handOffAnswers(card, input.response, answersDirectory) });
    },
    onEvent(listener: (event: ProviderEvent) => void) {
      return connection.onEvent((event) => {
        if (event.type === "session.permission_resolved") cards.delete(event.permissionId);
        listener(event.type === "session.permission" ? { ...event, request: rebuild(event.request, cards) } : event);
      });
    },
    async close() {
      cards.clear();
      await connection.close();
    },
  };
}

function rebuild(request: ProviderPermissionRequest, cards: Map<string, ProviderPermissionRequest>): ProviderPermissionRequest {
  const question = questionPermission(request);
  if (question) {
    cards.set(question.id, question);
    return question;
  }
  return planPermission(request) ?? request;
}

/**
 * A response that carries answers is one Paseo's question form filled in; every other client answers
 * with an action alone, and the adapter reads those off the option id. The document is written
 * before the response is forwarded, so the adapter never races it.
 */
async function handOffAnswers(
  card: ProviderPermissionRequest,
  response: ProviderPermissionResponse,
  answersDirectory: string,
): Promise<ProviderPermissionResponse> {
  if (response.behavior !== "allow") return response;
  const answers = answersByQuestion(response.updatedInput, card);
  if (Object.keys(answers).length === 0) return response;
  await writeCardAnswers(answersDirectory, cardId(card.id), answers);
  return { behavior: "allow", selectedActionId: response.selectedActionId ?? SUBMIT_OPTION_ID };
}

function cardId(permissionId: string): string {
  return permissionId.startsWith(PERMISSION_ID_PREFIX) ? permissionId.slice(PERMISSION_ID_PREFIX.length) : permissionId;
}
