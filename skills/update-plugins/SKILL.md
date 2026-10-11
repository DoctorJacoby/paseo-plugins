---
name: update-plugins
description: Rebuild and reload the paseo plugins installed on this host from the sleeyax/paseo-plugins checkout, including the apps under apps/ that a directory install never builds. Use when the user asks to update, rebuild, reinstall, or reload the paseo plugins they have installed from this repo.
---

# Update the plugins installed from this repo

Every plugin in this repository is installed against its own directory, so the daemon runs these files directly.
"Update" therefore means: get the working copy current, run the builds a directory install never runs itself, reload so the daemon recompiles the client and server bundles, and confirm each one is running.

Nothing here is specific to one coding agent. It is shell commands and the files in this checkout.

## Requirements

`paseo` and `pnpm` must both be on `PATH`. If either is missing, say which and stop — there is nothing useful to do without it.

## Hard rules

- **Only act on plugins the daemon already has.** `paseo plugin ls` is the list. A plugin that exists under `plugins/` but is not installed is not this skill's business — do not install it, do not mention it.
- **Never touch git beyond a fast-forward pull.** No stash, no checkout, no fetch-and-reset. If the pull does not apply cleanly under the conditions below, skip it and rebuild the working copy as it stands.
- **Never reload the provider hosting this session.** A reload closes every session on that provider, this one included, so the command never returns and the run ends in a system error. Type it into a workspace terminal for the user to run instead.
- **Reload `claude-tty` last.** A reload closes the other sessions on its provider too. Everything else must be finished before that risk is taken.
- **Report failures with their output.** A build that fails, a plugin that comes back `error` — say so and quote the error. Do not reload on top of a failed build and call it done.

## Steps

### 0. Confirm this is the right checkout

This skill can be installed globally, so it cannot assume where it is running.

```sh
git rev-parse --show-toplevel 2>/dev/null
```

The repository root must contain `pnpm-workspace.yaml` and a `plugins/` directory holding `paseo-plugin.json` manifests. If it does not, this is not the paseo-plugins checkout — say so and stop. Everything below runs from that root.

### 1. Gather the state — one shell invocation

Batch it; do not spend a round trip per fact.

```sh
paseo plugin ls
paseo plugin ls --json
git status --short --branch
git rev-parse --abbrev-ref --symbolic-full-name '@{u}' 2>&1
[ -n "$PASEO_AGENT_ID" ] && paseo inspect "$PASEO_AGENT_ID" --json
[ -n "$PASEO_AGENT_ID" ] && jq -r .workspaceId "${PASEO_HOME:-$HOME/.paseo}"/agents/*/"$PASEO_AGENT_ID".json
```

From `ls --json` take the `id` and `path` of every installed plugin. Keep the ones whose `path` is inside this repository; drop the rest.

The table adds a `SOURCE` column the JSON does not have:

- `directory` — the daemon runs this working copy. These are what the rest of this skill handles.
- `git` — the daemon runs its own clone, and nothing local reaches it. For those, `paseo plugin update <id>` is the whole update; it fetches and runs the manifest build in the daemon's checkout. Run it, report it, and leave them out of steps 3–4.

If nothing survives the filter, say so and stop.

`PASEO_AGENT_ID` is set when Paseo hosts this session, and `Provider` in the `inspect` output names the provider it runs on.
A plugin whose `id` equals that provider is the one hosting this session: build it like the rest, but leave it out of the reloads in step 4.
The `jq` line reads the workspace this session belongs to from the daemon's agent record, because `inspect` leaves it out; step 4 needs it for that plugin's terminal.

### 2. Pull, but only when it is free

Pull only when all three hold: the working tree is clean, `HEAD` is the default branch, and it has an upstream.

```sh
git pull --ff-only
```

Otherwise skip it and name the reason in one clause — dirty tree, on a branch, no upstream. A skipped pull is not an error; the rebuild still runs against what is checked out.

### 3. Run each plugin's manifest build

`paseo-plugin.json` holds the `build` array the daemon runs on a git install, and it is the authority on what a plugin needs built.
A directory install runs none of it, which is why the app under `apps/` goes stale.

For each surviving plugin, read `plugins/<id>/paseo-plugin.json`. Plugins with no `build` key need nothing. For the ones that have it, run each command **from that plugin's directory** — `pnpm` walks up to the workspace root from there, and the manifest's filters are written expecting that cwd:

```sh
cd plugins/claude-tty
pnpm install --frozen-lockfile
pnpm --filter @paseo-plugins/claude-tty-acp build
```

Deduplicate across plugins: `pnpm install --frozen-lockfile` covers the whole workspace, so run it once no matter how many manifests ask for it.

If `--frozen-lockfile` fails, the lockfile is behind `package.json`. Report that and stop — do not swap in a plain `pnpm install` to get past it, because that changes the lockfile the daemon installs from.

### 4. Reload, `claude-tty` last

```sh
paseo plugin reload <id> --json
```

`status` in the response is the answer: `running` is a clean reload, anything else is a failure. Reload is the compile check for `index.client.tsx` and `index.server.ts`, so a bundle that no longer compiles surfaces here.

Skip the plugin hosting this session, if step 1 found one, and type its reload into a terminal of this workspace without pressing Enter, so the user runs it once they are done with the session:

```sh
terminal=$(paseo terminal create --workspace <workspaceId> --cwd "$PWD" --name "reload <id>" -q)
paseo terminal send-keys --literal "$terminal" 'paseo plugin reload <id> --json'
```

Pass the workspace from step 1 rather than relying on `--cwd`: given a directory alone, the daemon picks one of the workspaces open on it, and with several open on this checkout that is often not the user's. Address the terminal by the ID `create` prints, since a name can match a leftover terminal from an earlier run.
If step 1 found no agent record, drop `--workspace` and name the workspace the terminal landed in, from `paseo terminal ls --json` and `paseo workspace ls --json`, so the user knows where to look.

The daemon owns that terminal, so it outlives the sessions the reload closes.

For any plugin that did not come back `running`, read its output:

```sh
paseo plugin logs <id>
```

### 5. Report

One short summary:

- Whether the pull ran, and the commit range it brought in — or why it was skipped.
- What was rebuilt.
- Each plugin reloaded, with its status.
- Anything that failed, with the error.
- When a plugin was skipped because it hosts this session, end by pointing the user at the `reload <id>` terminal, and say that pressing Enter there closes this session.

When `claude-tty` was among them, add the one caveat that is not visible from the status: an adapter process keeps the code it started with, so the rebuilt adapter reaches only sessions started after the reload. Existing sessions carry the old one until they are restarted.
Its adapter log is `~/.local/state/claude-tty-acp/logs/claude-tty-acp.log`, separate from the plugin's own `paseo plugin logs claude-tty`, because the daemon drops the adapter's stderr.
