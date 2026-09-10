import assert from "node:assert/strict";
import test from "node:test";
import { parseDiagnosticsReport } from "./diagnostics.ts";

const report = {
  version: "0.1.0",
  ok: false,
  checks: [
    { id: "node", label: "Node.js", ok: true, detail: "v24.20.0" },
    { id: "claude", label: "Claude CLI", ok: false, detail: "claude: not found" },
  ],
};

test("reads the report the adapter prints", () => {
  assert.deepEqual(parseDiagnosticsReport(`${JSON.stringify(report)}\n`), report);
});

test("ignores whatever the daemon's environment printed first", () => {
  assert.deepEqual(parseDiagnosticsReport(`(node:1) ExperimentalWarning: Type Stripping is an experimental feature\n${JSON.stringify(report)}\n`), report);
});

test("rejects output that is not a report", () => {
  assert.equal(parseDiagnosticsReport(""), null);
  assert.equal(parseDiagnosticsReport("   \n"), null);
  assert.equal(parseDiagnosticsReport("OK  Node.js: v24.20.0\n"), null);
  assert.equal(parseDiagnosticsReport('{"ok":true}'), null);
  assert.equal(parseDiagnosticsReport('{"checks":[]}'), null);
  assert.equal(parseDiagnosticsReport('[{"ok":true,"checks":[]}]'), null);
  assert.equal(parseDiagnosticsReport('{"ok":true,"checks":[{"id":"node"}]}'), null);
});

test("tolerates a report from a build that does not name its version", () => {
  assert.deepEqual(parseDiagnosticsReport('{"ok":true,"checks":[]}'), { version: null, ok: true, checks: [] });
});
