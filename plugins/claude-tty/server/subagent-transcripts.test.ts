import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { parseSidecar, readSidecars, SubagentTranscript } from "./subagent-transcripts.ts";

async function directory(): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), "claude-tty-subagents-"));
}

async function append(file: string, records: unknown[]): Promise<void> {
  await writeFile(file, `${records.map((record) => JSON.stringify(record)).join("\n")}\n`, { flag: "a" });
}

function assistant(content: unknown[]): unknown {
  return { type: "assistant", message: { content } };
}

test("reads the launch a sidecar names, which is the only handle the conversation shares", () => {
  const sidecar = parseSidecar("a1", JSON.stringify({ agentType: "Explore", description: "Find it", toolUseId: "toolu_1", spawnDepth: 1 }));
  assert.deepEqual(sidecar, { agentId: "a1", toolUseId: "toolu_1", agentType: "Explore", description: "Find it", nested: false });
  assert.equal(parseSidecar("a1", JSON.stringify({ spawnDepth: 2 }))?.nested, true);
  assert.equal(parseSidecar("a1", "not json"), null);
  assert.equal(parseSidecar("a1", null), null);
});

test("lists only the agents Claude wrote a sidecar for", async () => {
  const root = await directory();
  await writeFile(path.join(root, "agent-a1.meta.json"), JSON.stringify({ toolUseId: "toolu_1", agentType: "Explore" }));
  await writeFile(path.join(root, "agent-a1.jsonl"), "");
  await writeFile(path.join(root, "agent-a2.jsonl"), "");

  assert.deepEqual((await readSidecars(root)).map((sidecar) => sidecar.agentId), ["a1"]);
  assert.deepEqual(await readSidecars(path.join(root, "never")), []);
});

test("turns a subagent's records into the timeline a subsession carries", async () => {
  const root = await directory();
  const file = path.join(root, "agent-a1.jsonl");
  await append(file, [
    { type: "user", message: { content: "Find the seam" } },
    assistant([{ type: "text", text: "Looking." }]),
    assistant([{ type: "tool_use", id: "toolu_read", name: "Read", input: { file_path: "/work/index.ts" } }]),
  ]);
  const transcript = new SubagentTranscript(root, "a1");

  const items = await transcript.read();
  assert.deepEqual(
    items.map((item) => [item.type, item.type === "tool_call" ? item.status : ""]),
    [
      ["user_message", ""],
      ["assistant_message", ""],
      ["tool_call", "running"],
    ],
  );
  assert.deepEqual(items[2]?.type === "tool_call" ? items[2].detail : null, { type: "read", filePath: "/work/index.ts" });
});

test("closes a tool call with what it came back with, and reads a failure as one", async () => {
  const root = await directory();
  const file = path.join(root, "agent-a1.jsonl");
  await append(file, [assistant([{ type: "tool_use", id: "toolu_bash", name: "Bash", input: { command: "pnpm test" } }])]);
  const transcript = new SubagentTranscript(root, "a1");
  await transcript.read();

  await append(file, [{ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "toolu_bash", content: "3 passing" }] } }]);
  const [completed] = await transcript.read();
  assert.equal(completed?.type === "tool_call" ? completed.status : null, "completed");
  assert.deepEqual(completed?.type === "tool_call" ? completed.detail : null, {
    type: "shell",
    command: "pnpm test",
    cwd: undefined,
    output: "3 passing",
  });

  await append(file, [
    assistant([{ type: "tool_use", id: "toolu_edit", name: "Edit", input: { file_path: "/work/a.ts", old_string: "a", new_string: "b" } }]),
    { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "toolu_edit", is_error: true, content: "String not found" }] } },
  ]);
  const failed = (await transcript.read()).at(-1);
  assert.equal(failed?.type === "tool_call" ? failed.status : null, "failed");
  assert.equal(failed?.type === "tool_call" ? failed.error : null, "String not found");
});

test("hands back only what is new, and cancels what the agent left running", async () => {
  const root = await directory();
  const file = path.join(root, "agent-a1.jsonl");
  await append(file, [assistant([{ type: "text", text: "one" }])]);
  const transcript = new SubagentTranscript(root, "a1");
  assert.equal((await transcript.read()).length, 1);
  assert.deepEqual(await transcript.read(), []);

  await append(file, [assistant([{ type: "tool_use", id: "toolu_open", name: "Grep", input: { pattern: "seam" } }])]);
  assert.equal((await transcript.read()).length, 1);
  const [canceled] = transcript.settle();
  assert.equal(canceled?.type === "tool_call" ? canceled.status : null, "canceled");
  assert.deepEqual(transcript.settle(), []);
});

test("says nothing for an agent whose transcript is not there yet", async () => {
  const root = await directory();
  assert.deepEqual(await new SubagentTranscript(root, "missing").read(), []);
});
