import assert from "node:assert/strict";
import test from "node:test";
import { parseCliArgs } from "./cli-options.ts";

test("serves ACP when no CLI flags are passed", () => {
  assert.deepEqual(parseCliArgs([]), { kind: "serve", settingsFile: null });
});

test("takes the settings document the plugin names at spawn", () => {
  assert.deepEqual(parseCliArgs(["--settings-file", "/paseo/plugin-settings/claude-tty/settings.json"]), {
    kind: "serve",
    settingsFile: "/paseo/plugin-settings/claude-tty/settings.json",
  });
});

test("rejects --settings-file without a path", () => {
  assert.throws(() => parseCliArgs(["--settings-file"]), /Unknown arguments/);
  assert.throws(() => parseCliArgs(["--settings-file", "--json"]), /Unknown arguments/);
  assert.throws(() => parseCliArgs(["--settings-file", ""]), /Unknown arguments/);
});

test("prints help and version without starting ACP", () => {
  const help = parseCliArgs(["--help"]);
  assert.equal(help.kind, "print");
  assert.match(help.text, /Usage:/);
  assert.deepEqual(parseCliArgs(["--version"]), { kind: "print", text: "0.1.0" });
});

test("selects host diagnostics", () => {
  assert.deepEqual(parseCliArgs(["--diagnose"]), { kind: "diagnose", json: false });
});

test("selects machine-readable diagnostics with the flags in either order", () => {
  assert.deepEqual(parseCliArgs(["--diagnose", "--json"]), { kind: "diagnose", json: true });
  assert.deepEqual(parseCliArgs(["--json", "--diagnose"]), { kind: "diagnose", json: true });
});

test("rejects --json without --diagnose", () => {
  assert.throws(() => parseCliArgs(["--json"]), /Unknown arguments/);
  assert.throws(() => parseCliArgs(["--json", "--json"]), /Unknown arguments/);
  assert.throws(() => parseCliArgs(["--diagnose", "--diagnose"]), /Unknown arguments/);
});

test("rejects unknown flags", () => {
  assert.throws(() => parseCliArgs(["--wat"]), /Unknown arguments/);
});
