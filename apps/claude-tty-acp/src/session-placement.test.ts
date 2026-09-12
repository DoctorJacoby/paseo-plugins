import assert from "node:assert/strict";
import http from "node:http";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { AgentSideConnection, SessionNotification } from "@agentclientprotocol/sdk";
import type { IPty, IPtyForkOptions } from "node-pty";
import { ClaudeTtyAgent } from "./agent.ts";
import { HOST_SESSION_VARIABLE, resolvePlacement } from "./session-placement.ts";

/**
 * A stand-in for the host's toolchain-box, answering `session` from a script the test writes and
 * recording every call. The real one is dotfiles' `hosts/vps/bin/toolchain-box`; what matters here
 * is that the adapter asks it and obeys, which is the whole of the contract between them.
 */
async function fakeToolchainBox(directory: string, answer: string): Promise<{ command: string; calls: () => Promise<string[]> }> {
  const command = path.join(directory, "toolchain-box");
  const log = path.join(directory, "calls");
  await writeFile(
    command,
    `#!/bin/bash\necho "$@" >>${JSON.stringify(log)}\n[ "$1" = session ] || exit 0\ncat <<'ANSWER'\n${answer}\nANSWER\n`,
    { mode: 0o700 },
  );
  await chmod(command, 0o700);
  return {
    command,
    calls: async () => (await readFile(log, "utf8").catch(() => "")).split("\n").filter((line) => line !== ""),
  };
}

test("takes the host for one agent when the spawn asked for it, without asking the host at all", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "placement-flag-"));
  try {
    const box = await fakeToolchainBox(directory, "enabled 1\nplacement refuse\nreason nowhere");
    const placement = await resolvePlacement("/work/ops", { TOOLCHAIN_BOX_BIN: box.command, [HOST_SESSION_VARIABLE]: "1" });

    assert.equal(placement.boxed, false);
    assert.match(placement.reason, /CLAUDE_TTY_HOST_SESSION=1/);
    assert.deepEqual(await box.calls(), []);
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
});

test("runs on the host where the host says a workspace may, and says which one", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "placement-allowed-"));
  try {
    const box = await fakeToolchainBox(directory, "enabled 1\nplacement host\nreason /home/me/dotfiles is a host workspace in sessions");
    const placement = await resolvePlacement("/home/me/dotfiles/hosts", { TOOLCHAIN_BOX_BIN: box.command });

    assert.equal(placement.boxed, false);
    assert.equal(placement.configDir, undefined);
    assert.match(placement.reason, /is a host workspace/);
    assert.deepEqual(await box.calls(), ["session /home/me/dotfiles/hosts"]);
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
});

test("refuses a session the host will neither box nor allow, and names the paved road", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "placement-refused-"));
  try {
    const box = await fakeToolchainBox(directory, "enabled 1\nplacement refuse\nreason /work/new is in no checkout with a session box");
    await assert.rejects(resolvePlacement("/work/new", { TOOLCHAIN_BOX_BIN: box.command }), (error: Error) => {
      assert.match(error.message, /\/work\/new is in no checkout with a session box/);
      assert.match(error.message, /toolchain-box\/projects/);
      assert.match(error.message, /work-organisation#56/);
      assert.match(error.message, new RegExp(`${HOST_SESSION_VARIABLE}=1`));
      return true;
    });
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
});

test("refuses a session's first turn rather than its open, and says so in the turn's own error", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "placement-refused-acp-"));
  const updates: SessionNotification[] = [];
  try {
    const box = await fakeToolchainBox(directory, "enabled 1\nplacement refuse\nreason /work/new is in no checkout with a session box");
    const spawned: unknown[] = [];
    const agent = new ClaudeTtyAgent(
      { sessionUpdate: async (update: SessionNotification) => void updates.push(update), extNotification: async () => undefined } as unknown as AgentSideConnection,
      {
        spawnPty: (...args: unknown[]) => {
          spawned.push(args);
          throw new Error("a refused session must never reach a pty");
        },
        resolvePlacement: (cwd: string) => resolvePlacement(cwd, { TOOLCHAIN_BOX_BIN: box.command }),
        stateDirectory: path.join(directory, "state"),
      } as unknown as ConstructorParameters<typeof ClaudeTtyAgent>[1],
    );

    // The open itself has to succeed: the daemon builds this provider's catalogue from the first
    // session on a connection and remembers a rejected open against the provider, which would
    // refuse every later spawn in every workspace.
    const session = await agent.newSession({ cwd: "/work/new", mcpServers: [] });
    await waitFor(() => updates.some((update) => update.update.sessionUpdate === "available_commands_update"));

    // Anything but a RequestError reaches the daemon as "Internal error" with the reason in data
    // that nothing reads, which is a refusal nobody can act on.
    await assert.rejects(agent.prompt({ sessionId: session.sessionId, prompt: [{ type: "text", text: "hello" }] }), (error: Error & { code?: number }) => {
      assert.equal(error.code, ClaudeTtyAgent.REFUSED_CODE);
      assert.match(error.message, /has no session box/);
      assert.match(error.message, /toolchain-box\/projects/);
      return true;
    });
    assert.deepEqual(spawned, []);
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
});

test("moves only what lies inside the box's agent home between the two sides of the mount", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "placement-paths-"));
  try {
    const box = await fakeToolchainBox(
      directory,
      "enabled 1\nplacement box\nroot /work/repo\nagent-home /state/tcbox-repo/claude\nguest-home /home/node/.claude",
    );
    const placement = await resolvePlacement("/work/repo/packages/api", { TOOLCHAIN_BOX_BIN: box.command });

    assert.equal(placement.boxed, true);
    assert.equal(placement.configDir, "/state/tcbox-repo/claude");
    assert.equal(placement.runtimeRoot, "/state/tcbox-repo/claude/paseo");
    assert.equal(placement.guest("/state/tcbox-repo/claude/paseo/run/settings.json"), "/home/node/.claude/paseo/run/settings.json");
    assert.equal(placement.host("/home/node/.claude/projects/-work-repo/abc.jsonl"), "/state/tcbox-repo/claude/projects/-work-repo/abc.jsonl");
    // The checkout is mounted at its own path, so nothing about it moves.
    assert.equal(placement.guest("/work/repo/src/index.ts"), "/work/repo/src/index.ts");
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
});

test("starts a boxed session through the host's toolchain-box, with every path Claude reads written as the box sees it", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "placement-boxed-"));
  const agentHome = path.join(directory, "claude");
  const guestHome = "/home/node/.claude";
  await mkdir(agentHome, { recursive: true });
  const box = await fakeToolchainBox(
    directory,
    `enabled 1\nplacement box\nroot /work/repo\nagent-home ${agentHome}\nguest-home ${guestHome}`,
  );

  const spawns: Array<{ file: string; args: string[]; options: IPtyForkOptions }> = [];
  const updates: SessionNotification[] = [];
  let agent!: ClaudeTtyAgent;
  const spawnPty = (file: string, args: string[], options: IPtyForkOptions): Pick<IPty, "pid" | "write" | "kill" | "onData" | "onExit"> => {
    spawns.push({ file, args, options });
    const sessionId = args[args.indexOf("--session-id") + 1];
    setImmediate(() => void agent.hooks.dispatch({ hook_event_name: "SessionStart", session_id: sessionId }));
    return {
      pid: 4242,
      write: () => undefined,
      kill: () => undefined,
      onData: () => ({ dispose: () => undefined }),
      onExit: () => ({ dispose: () => undefined }),
    } as unknown as Pick<IPty, "pid" | "write" | "kill" | "onData" | "onExit">;
  };
  agent = new ClaudeTtyAgent(
    { sessionUpdate: async (update: SessionNotification) => void updates.push(update), extNotification: async () => undefined } as unknown as AgentSideConnection,
    {
      spawnPty,
      resolvePlacement: (cwd) => resolvePlacement(cwd, { TOOLCHAIN_BOX_BIN: box.command }),
      stateDirectory: path.join(directory, "state"),
      startupTimeoutMs: 2_000,
      readinessTimeoutMs: 0,
      submitDelayMs: 0,
      contextRefreshTimeoutMs: 0,
    },
  );

  try {
    const session = await agent.newSession({ cwd: "/work/repo", mcpServers: [] });
    const turn = agent.prompt({ sessionId: session.sessionId, prompt: [{ type: "text", text: "hello" }] });
    await waitFor(() => spawns.length === 1);
    const [spawn] = spawns;
    assert.ok(spawn);

    // The box is started before Claude is, and through the host's own tool.
    assert.deepEqual(await box.calls(), ["session /work/repo", "up --implicit /work/repo"]);
    assert.equal(spawn.file, box.command);
    assert.deepEqual(spawn.args.slice(0, 5), ["exec", "--", "claude", "--session-id", session.sessionId]);
    assert.equal(spawn.options.cwd, "/work/repo");
    assert.equal((spawn.options.env as NodeJS.ProcessEnv).TOOLCHAIN_BOX_NO_WAIT, "1");

    // The runtime directory is in the box's ~/.claude, because a box reads none of this host's /tmp.
    const runs = await readdir(path.join(agentHome, "paseo"));
    const run = runs.find((name) => name.startsWith("claude-tty-acp-"));
    assert.ok(run);
    const hostRun = path.join(agentHome, "paseo", run);
    const guestRun = path.join(guestHome, "paseo", run);
    assert.equal(spawn.args.at(-2), "--settings");
    assert.equal(spawn.args.at(-1), path.join(guestRun, "settings.json"));

    const settings = JSON.parse(await readFile(path.join(hostRun, "settings.json"), "utf8")) as {
      statusLine: { command: string };
      hooks: { Stop: Array<{ hooks: Array<{ command: string }> }> };
    };
    assert.match(settings.statusLine.command, new RegExp(path.join(guestRun, "context.json")));
    // The box's node, not this adapter's: `process.execPath` is a path only this host has.
    assert.equal(settings.hooks.Stop[0]?.hooks[0]?.command, `'node' '${path.join(guestRun, "hook-client.mjs")}'`);

    // The hook client posts over a unix socket in that same directory, because a box reaches none
    // of this host's loopback. Posting to it is what proves the channel is really open.
    const client = await readFile(path.join(hostRun, "hook-client.mjs"), "utf8");
    const target = /http\.request\(\{ \.\.\.(\{.*?\}),/.exec(client)?.[1];
    assert.ok(target);
    const { socketPath, path: requestPath } = JSON.parse(target) as { socketPath: string; path: string };
    assert.equal(socketPath, path.join(guestRun, "hooks.sock"));
    await post(path.join(hostRun, "hooks.sock"), requestPath, { hook_event_name: "Stop", session_id: session.sessionId, last_assistant_message: "done" });

    assert.deepEqual(await turn, { stopReason: "end_turn" });
    assert.ok(updates.some((update) => update.update.sessionUpdate === "agent_message_chunk"));
  } finally {
    await agent.close();
    await rm(directory, { force: true, recursive: true });
  }
});

function post(socketPath: string, requestPath: string, payload: unknown): Promise<void> {
  const body = Buffer.from(JSON.stringify(payload));
  return new Promise((resolve, reject) => {
    const request = http.request(
      { socketPath, path: requestPath, method: "POST", headers: { "content-type": "application/json", "content-length": body.length } },
      (response) => {
        response.resume();
        response.on("end", () => (response.statusCode === 200 ? resolve() : reject(new Error(`hook socket answered ${response.statusCode}`))));
      },
    );
    request.on("error", reject);
    request.end(body);
  });
}

async function waitFor(condition: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("Timed out waiting for the adapter");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
