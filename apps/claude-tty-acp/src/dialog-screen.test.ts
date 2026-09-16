import assert from "node:assert/strict";
import test from "node:test";
import { choiceSelected, dialogTitle, readDialog, sameDialog } from "./dialog-screen.ts";

/**
 * A nudge as Claude draws one: in a box, with the rows numbered and the marker on the selected one.
 * The snapshot the adapter reads has already had trailing whitespace taken off and empty lines dropped,
 * so the fixtures are written the way `TerminalScreen.snapshot()` hands them over.
 */
const NUMBERED_DIALOG = [
  "  Read the file and found three call sites.",
  "╭────────────────────────────────────────────────────────╮",
  "│ Claude Code can use the Playwright plugin for this      │",
  "│ project.                                                │",
  "│                                                         │",
  "│ ❯ 1. Yes, add it                                        │",
  "│   2. No thanks                                          │",
  "│   3. Don't ask again for this project                   │",
  "│                                                         │",
  "│ Enter to confirm · Esc to cancel                        │",
  "╰────────────────────────────────────────────────────────╯",
].join("\n");

/** The auto-mode setup question, which numbers nothing and marks the row it is on the same way. */
const CHECKBOX_DIALOG = [
  "Claude Code reads this project, your recent Claude sessions, and optionally your shell history.",
  "❯ Also scan shell history    [✔]",
  "  Also scan your other repos   [ ]",
  "Enter to confirm · Esc to cancel",
].join("\n");

test("reads a numbered dialog out of the box Claude draws it in", () => {
  const dialog = readDialog(NUMBERED_DIALOG);
  assert.equal(dialog?.question, "Claude Code can use the Playwright plugin for this\nproject.");
  assert.deepEqual(dialog?.choices, [
    { label: "Yes, add it", selected: true, number: 1 },
    { label: "No thanks", selected: false, number: 2 },
    { label: "Don't ask again for this project", selected: false, number: 3 },
  ]);
  // The conversation above the box is not the question, and the footer is not a row.
  assert.ok(!dialog!.question.includes("call sites"));
  assert.ok(!dialog!.choices.some((choice) => choice.label.includes("Enter to confirm")));
  // The card's title is the question, and the text it carries is the dialog as drawn.
  assert.equal(dialogTitle(dialog!), "Claude Code can use the Playwright plugin for this");
  assert.ok(dialog!.text.includes("Yes, add it"));
  assert.ok(dialog!.text.includes("Enter to confirm"));
});

test("reads a dialog that numbers nothing from the column its rows start in", () => {
  const dialog = readDialog(CHECKBOX_DIALOG);
  assert.deepEqual(dialog?.choices, [
    { label: "Also scan shell history [✔]", selected: true, number: null },
    { label: "Also scan your other repos [ ]", selected: false, number: null },
  ]);
  assert.equal(dialog?.question, "Claude Code reads this project, your recent Claude sessions, and optionally your shell history.");
});

test("follows the marker rather than the row it started on", () => {
  const moved = CHECKBOX_DIALOG.replace("❯ Also scan shell history", "  Also scan shell history").replace(
    "  Also scan your other repos",
    "❯ Also scan your other repos",
  );
  assert.ok(choiceSelected(CHECKBOX_DIALOG, "Also scan shell history [✔]"));
  assert.ok(!choiceSelected(moved, "Also scan shell history [✔]"));
  assert.ok(choiceSelected(moved, "Also scan your other repos [ ]"));
  // Moving the marker is not a different dialog; the card raised for one is still the one on screen.
  assert.ok(sameDialog(readDialog(CHECKBOX_DIALOG), readDialog(moved)));
  assert.ok(!sameDialog(readDialog(CHECKBOX_DIALOG), readDialog(NUMBERED_DIALOG)));
});

test("offers no choices rather than invented ones when nothing on the screen is a row", () => {
  const dialog = readDialog(["Claude needs to run a command outside its sandbox.", "npm install --global something"].join("\n"));
  assert.deepEqual(dialog?.choices, []);
  // The text is still there, which is the whole of what makes such a card worth raising: a person can
  // read what Claude is asking even where nothing here could parse it, and dismiss it.
  assert.ok(dialog?.text.includes("outside its sandbox"));
  assert.equal(dialogTitle(dialog!), "Claude needs to run a command outside its sandbox.");
});

test("says nothing about a terminal that has painted nothing", () => {
  assert.equal(readDialog(""), null);
  assert.equal(readDialog("   \n  "), null);
  assert.equal(sameDialog(null, null), false);
});

test("stops following rows at the line that says which keys answer them", () => {
  const dialog = readDialog(
    ["❯ 1. Keep going", "  2. Stop here", "  Enter to confirm · Esc to cancel", "  Some later line at the same indent"].join("\n"),
  );
  assert.deepEqual(
    dialog?.choices.map((choice) => choice.label),
    ["Keep going", "Stop here"],
  );
});
