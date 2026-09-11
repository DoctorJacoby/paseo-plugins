import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import {
  adapterBinaryPath,
  adapterCommand,
  adapterEntryPath,
  adapterManifestPath,
  claudeCandidates,
  daemonConfigPath,
  defaultStateDirectory,
  executableCandidates,
  legacySettingsFilePath,
  repoRootFromPluginPath,
  settingsFilePath,
  subagentsDirectory,
  transcriptPath,
} from "./paths.ts";

test("resolves the state directory the way the adapter does", () => {
  assert.equal(defaultStateDirectory({ CLAUDE_TTY_ACP_STATE_DIR: "/srv/state" }), "/srv/state");
  assert.equal(
    defaultStateDirectory({ XDG_STATE_HOME: "/srv/xdg", HOME: "/home/paseo" }),
    "/srv/xdg/claude-tty-acp",
  );
  assert.equal(defaultStateDirectory({ HOME: "/home/paseo" }), "/home/paseo/.local/state/claude-tty-acp");
  assert.equal(defaultStateDirectory({ CLAUDE_TTY_ACP_STATE_DIR: "  ", HOME: "/home/paseo" }), "/home/paseo/.local/state/claude-tty-acp");
});

test("derives the checkout and its adapter from the installed plugin path", () => {
  const root = repoRootFromPluginPath("/opt/paseo-plugins/plugins/claude-tty");
  assert.equal(root, "/opt/paseo-plugins");
  assert.equal(adapterManifestPath(root), "/opt/paseo-plugins/apps/claude-tty-acp/package.json");
  assert.equal(adapterBinaryPath(root), "/opt/paseo-plugins/apps/claude-tty-acp/bin/claude-tty-acp");
  assert.equal(adapterEntryPath(root), "/opt/paseo-plugins/apps/claude-tty-acp/dist/cli.js");
});

test("finds the host's settings document beside the daemon configuration", () => {
  const env = { PASEO_HOME: "/srv/paseo" };
  assert.equal(daemonConfigPath(env), "/srv/paseo/config.json");
  assert.equal(settingsFilePath(env), "/srv/paseo/plugin-settings/claude-tty/settings.json");
  assert.equal(settingsFilePath({ HOME: "/home/paseo" }), "/home/paseo/.paseo/plugin-settings/claude-tty/settings.json");
});

test("finds the settings file an older install kept in the cache directory", () => {
  assert.equal(legacySettingsFilePath({ XDG_CACHE_HOME: "/srv/cache" }), "/srv/cache/paseo-plugins/claude-tty/settings.json");
  assert.equal(legacySettingsFilePath({ HOME: "/home/paseo" }), "/home/paseo/.cache/paseo-plugins/claude-tty/settings.json");
});

test("spawns the adapter with the settings document it is to read", () => {
  assert.deepEqual(adapterCommand("/opt/paseo-plugins", { PASEO_HOME: "/srv/paseo" }), [
    "/opt/paseo-plugins/apps/claude-tty-acp/bin/claude-tty-acp",
    "--settings-file",
    "/srv/paseo/plugin-settings/claude-tty/settings.json",
  ]);
});

test("strips a trailing separator from the installed plugin path", () => {
  assert.equal(repoRootFromPluginPath("/opt/paseo-plugins/plugins/claude-tty/"), "/opt/paseo-plugins");
});

test("lists PATH candidates in the order a shell would try them", () => {
  assert.deepEqual(executableCandidates("claude", { PATH: ["/usr/local/bin", "", "/usr/bin"].join(path.delimiter) }), [
    "/usr/local/bin/claude",
    "/usr/bin/claude",
  ]);
  assert.deepEqual(executableCandidates("claude", {}), []);
});

test("takes a command containing a separator as the only candidate", () => {
  assert.deepEqual(executableCandidates("/opt/bin/claude", { PATH: "/usr/bin" }), ["/opt/bin/claude"]);
});

test("prefers CLAUDE_BIN over PATH, as the adapter does", () => {
  assert.deepEqual(claudeCandidates({ CLAUDE_BIN: "/opt/claude/bin/claude", PATH: "/usr/bin" }), [
    "/opt/claude/bin/claude",
  ]);
  assert.deepEqual(claudeCandidates({ CLAUDE_BIN: " ", PATH: "/usr/bin" }), ["/usr/bin/claude"]);
});

test("finds a session's transcript and the subagent transcripts beside it", () => {
  const env = { HOME: "/home/me" };
  assert.equal(
    transcriptPath("/work/repo", "46ece69b", env),
    "/home/me/.claude/projects/-work-repo/46ece69b.jsonl",
  );
  assert.equal(
    subagentsDirectory("/work/repo", "46ece69b", env),
    "/home/me/.claude/projects/-work-repo/46ece69b/subagents",
  );
  assert.equal(
    transcriptPath("/work/repo", "46ece69b", { HOME: "/home/me", CLAUDE_CONFIG_DIR: "/config/claude" }),
    "/config/claude/projects/-work-repo/46ece69b.jsonl",
  );
});
