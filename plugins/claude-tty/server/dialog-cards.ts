import type { ProviderPermissionRequest } from "@getpaseo/plugin/server/provider";

/**
 * The key the adapter puts in the input of a card standing for one of Claude's own terminal dialogs,
 * mirrored from `apps/claude-tty-acp/src/dialog-cards.ts`. It is the input rather than the tool's name
 * because the ACP version in use has no field for a name, and the title of one of these is the question
 * itself. Keep the two copies in step: a marker that drifts leaves the card as the raw-JSON tool card
 * the bridge builds by default, which is still answerable but says far less.
 */
export const DIALOG_INPUT_MARKER = "claudeDialog";

/**
 * Claude's own dialog, made readable.
 *
 * `runAcpProvider` builds every permission the same way -- a tool card with the title, the raw input as
 * JSON, and a button per ACP option -- and there is nowhere in an ACP permission for the rest. What one
 * of these cards has to carry is the dialog as Claude drew it: the reading that produced the buttons is
 * best-effort, and the text on the screen is what makes an unparsed dialog answerable by a person
 * rather than a guess. So it goes in the description, which is also what `paseo permit ls` prints, and
 * again as the card's detail, which is where the app shows a block of text.
 */
export function dialogPermission(request: ProviderPermissionRequest): ProviderPermissionRequest | null {
  if (!isDialogPermission(request)) return null;
  const input = request.input!;
  const question = readString(input.question);
  const terminal = readString(input.terminal);
  const waitingFor = readString(input.waitingFor);
  const description = [
    question ?? `Claude is waiting on ${waitingFor ?? "an answer"} in its terminal.`,
    terminal === undefined ? undefined : `Claude's terminal:\n${terminal}`,
    // A list longer than the room Claude draws it in offers only what was on screen when it was read.
    input.scrolls === true ? "This list is longer than Claude's window: the rows below are the ones it was showing." : undefined,
    "Answering moves Claude's own selection and presses Enter. Dismiss closes the question unanswered.",
  ]
    .filter((part): part is string => part !== undefined)
    .join("\n\n");
  return {
    ...request,
    // The title is the dialog's own, which the adapter has already read off the screen; what it says
    // under that title is the description, along with the dialog as drawn.
    description,
    ...(terminal === undefined ? {} : { detail: { type: "plain_text" as const, label: "Claude's terminal", text: terminal, icon: "wrench" } }),
  };
}

/** Whether this card stands for one of Claude's own terminal dialogs, which only the adapter raises. */
export function isDialogPermission(request: ProviderPermissionRequest): boolean {
  return request.input?.[DIALOG_INPUT_MARKER] === true;
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}
