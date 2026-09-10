# Working on this plugin

Run `paseo plugin reload claude-tty` after every change, then `paseo plugin logs claude-tty`.
Do this yourself; never leave it to the user.
Where a reload is not available — another agent's sessions are on this provider, say — the daemon's own compiler answers the same question without touching it: import `compilePlugin` from `@getpaseo/server/dist/server/server/plugins/compiler.js` and run it over the two entries, then `readPluginProviderIcon` from `provider-icon.js` beside it for the icon.
That log is the plugin's; the adapter's is `~/.local/state/claude-tty-acp/logs/claude-tty-acp.log`, because the daemon drops the adapter's stderr, and a running adapter process keeps the code it started with — a rebuilt `dist/` reaches the sessions started after it.

`paseo plugin add <repo> --path plugins/claude-tty` is the supported install: the daemon clones into a staging directory, runs the manifest's `build` commands there with the plugin directory as the cwd, and only then places and starts it.
`pnpm` walks up to the workspace root from that cwd, which is why `pnpm install --frozen-lockfile` and `pnpm --filter @paseo-plugins/claude-tty-acp build` are enough (verified by running both from `plugins/claude-tty`).
A directory install runs no build at all, so a clone has to be built by hand before it is added.

To exercise a handler without a client, invoke it over the daemon's own plugin RPC:

```js
import { connectToDaemon } from "/usr/lib/node_modules/@getpaseo/cli/dist/utils/client.js";
const client = await connectToDaemon({});
console.log(await client.invokePluginRpc("claude-tty", "claude-tty.status", {}));
```

That is the only way to see what a filesystem guard actually does, so use it rather than reasoning about the code.

## The checkout is not discoverable, and the daemon asks for the provider before it can be

The plugin runs the adapter built inside the checkout it was installed from, and nothing in the plugin runtime says where that is.
The server bundle is `eval`'d from a string in a wrapper taking only `require`, so it has no `__dirname`, and esbuild compiles `import.meta` to `{}`; the daemon's initialize message carries `pluginId`, `appVersion`, `bundle` and `settingsDirectory` and no path.
The daemon's own configuration is the one record, so `server/checkout.ts` reads `$PASEO_HOME/config.json` — the plugin process inherits `PASEO_HOME` from the daemon — rather than asking over `paseo.config.get()`, because `registerProvider` has to be called synchronously during the contribution and the daemon connects the provider about ten milliseconds after the plugin reports ready, long before any RPC has handed the plugin a `PaseoApi`.
`apps/claude-tty-acp/package.json` has to exist two levels above the plugin directory before anything else is worth reporting.
`server/paths.ts` is the naming vocabulary that resolving builds on and computes paths without touching the disk.

`connect()` is async, so the command is resolved per connection rather than at registration: `server/provider.ts` builds the `runAcpProvider` shim inside `connect` and delegates to it.
That shim spawns one adapter process per ACP session, plus a throwaway one per connection to probe capabilities and another per catalogue fetch, and it drops the adapter's stderr — which is why the diagnostics section still runs the adapter's own `--diagnose`.

## The host owns the settings, and the adapter is told where they are

`registerSettings` hands the daemon a schema and nothing else: it returns `void`, `PluginServerContext` has no way to read a value back, and the `settings.changed` the store emits travels to the *clients* — `subscribeSettings` in the daemon's `session.ts` turns it into a `plugin_settings_changed` broadcast — never back into the plugin runtime.
So there is no watcher to hang a mirror file off, and this plugin neither reads nor writes the document.

The store runs inside the plugin's own subprocess and keeps one file per definition at `$PASEO_HOME/plugin-settings/<plugin id>/<settings id>.json`, holding `{ "version", "values" }` where `version` is the definition's rather than the file format's.
Verified on a 0.8.0 daemon with a throwaway plugin: a missing file reads as the schema's defaults at revision `missing`, a write lands that envelope, and `paseo plugin remove` deletes the directory.
`server/paths.ts` rebuilds that path from `PASEO_HOME`, the way `daemonConfigPath` already did.

The adapter is a detached process the ACP shim spawns, so it is handed the path as `--settings-file` in the command `connect()` builds, and re-reads it at every suspension.
The alternatives were both worse: `runAcpProvider` takes no `env`, and a value passed at spawn would only reach the next adapter rather than the sessions already open, which is the behaviour the idle timeout is documented to have.

The setting is global, not per session. A per-session `ProviderSetting` is only ever *listed* from the ACP session's own `configOptions` — `toProviderConfigState` in the SDK's ACP connection builds `settings` from nothing else — and this adapter advertises none, so `session.configure` would have somewhere to deliver a change and nowhere to show it.
Making it per-session means giving the adapter a `session/set_config_option` surface first, which is adapter work rather than plugin work.

## The cards Paseo has for a question, and the answers ACP will not carry

`runAcpProvider` builds every permission the same way: `kind: "tool"`, the tool call's title, its raw input, and one action per ACP option.
`description`, `detail`, `metadata`, `variant` and `intent` have nowhere to come from, and on the way back `respondToPermission` resolves the ACP request with the id of the option it matched and drops the rest of the response — `updatedInput` included.
So `server/permission-bridge.ts` wraps the connection that shim returns: it rebuilds the two permissions that ask a person something on the way out, and takes the answers off the response on the way in.
The version of ACP this SDK speaks has no field for a tool's own name, so the adapter's `toolCall.title` carries it and the bridge reports it as the permission's `name`, which is what `server/question-cards.ts` matches on.

Paseo's question form is the whole reason the card is worth rebuilding, and its contract is strict (read out of the web UI the daemon serves, `dist/server/web-ui`).
It renders `request.input.questions`, and every question needs a string `question` and a string `header` and options that are objects with a string `label`; anything else makes `parseQuestionFormQuestions` return null, and the card then draws *nothing* and the permission cannot be answered there at all.
`multiSelect` picks checkboxes over radio buttons, `allowOther` adds the free-text box Claude's own schema says the host provides, an option's `description` renders under its label, and there is no surface for an option's `preview` — which is why a preview is folded into that description rather than dropped.
The form ignores `actions` entirely and keys its answers by `header`, so the headers are made distinct before they go out and the answers are read back onto the question text after, the way the daemon's own Claude provider does it.

Submit sends `{ behavior: "allow", updatedInput: { ...input, answers } }` and names no action, and the ACP bridge then resolves the *first* option whose behaviour matches.
That is why `submit` is first among the affirmative options and carries no answer of its own: it is what a bare allow — from that form, from `paseo permit allow`, from any client with a single Allow button — has to land on.
Dismiss sends a plain deny, which lands on `reply-in-chat` the same way.

The answers themselves travel by file, because nothing on the ACP connection would carry them: the bridge writes them under the directory the adapter is passed as `--answers-dir` and *then* forwards the response, so the adapter reading none means nobody answered rather than that it read too early.
Everything else answers with an option alone: one per possible answer while a single question is on the card, and only "Answer in chat" once there are several, since no one button can answer them all.
`paseo permit ls` shows the request's name and description, which is why the description summarises every question and its options, and `paseo permit allow <agent> <id> --input '{"answers":{...}}'` answers the whole card from a terminal — verified against a 0.8.0 daemon with a throwaway plugin, which is also where the `kind: "question"` and `kind: "plan"` requests below were checked end to end.
That CLI truncates the request id it prints to eight characters, so two of these permissions are told apart by `paseo inspect <agent> --json` rather than by `permit ls`.

There is no plugin timeline renderer for any of this, and there should not be one: the host's question card already does more than a renderer here would, and it is the only path in the app that sends `updatedInput` at all.
A plan is `kind: "plan"` with `metadata.planText`, which is what the host's plan card reads first, and Paseo's own Implement and Reject actions.
There is no `implement_resume` beside them: that intent means returning to the mode planning interrupted, and the permission mode is an argument the adapter launches Claude with, so a session cannot change it.

## Constraints that are not obvious

The daemon's `PATH` is not your shell's.
A systemd daemon typically has `/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin` and nothing else, so Claude is routinely missing from it.
That is a reading the surface reports, not an error to hide, and every spawn failure has to read as a sentence rather than a stack trace.

The plugin never builds the adapter itself; install and update do, through the manifest's `build`, and a directory install leaves it to whoever owns the checkout.
The surface reports whether `dist/cli.js` is there, because that is what a spawn failure will otherwise say opaquely.

A plugin session sees every provider in `providers.snapshot()`, custom and plugin-registered alike.
The daemon filters through `isProviderVisibleToClient`, which passes anything whose client declares `all_providers` or an `appVersion` of at least 0.1.45; the plugin's own client declares both, the second from the daemon version the initialize message carries.
Verified against a throwaway plugin on a 0.8.0 daemon, which saw `traecli` and its own provider in the entries.

The daemon validates a plugin provider on its way in: the ID must match `^[a-z][a-z0-9._-]*$`, may not be a builtin or an ID the configuration already holds, and the registration needs a non-empty label and a `connect`.
The ID is stored verbatim — no namespacing by plugin.
`icon` is a path relative to the plugin directory, read and sanitised once when the plugin starts: a regular SVG file under 64 KiB, with no script, style, `foreignObject`, event-handler attribute, JavaScript URL, or `href` that does not start with `#`. Editing it takes a reload.

Session and lock liveness is decided with signal 0 exactly the way the adapter decides it, so the two never disagree about which lock is stale.

Stopping a session signals the process the lock names, which is one adapter process per ACP session, spawned by the plugin process rather than the daemon since the provider moved into the plugin.
`SIGTERM` is enough: the adapter's own handler closes the session, which stops the Claude PTY and releases the lock, so the persisted session and the Paseo agent both survive and the next prompt resumes them.
Never signal a process group: the adapter is spawned undetached, so `-pid` is the plugin process's own group.

Reloading the plugin does not preserve a session, and there is no re-parenting.
The daemon stops the plugin, retires the provider, and closes every agent on it, persisting a snapshot first; the ACP shim SIGTERMs each adapter on the way out and escalates to `SIGKILL` after one second, which is where a lock can be left behind for "Release lock".
Recovery is lazy: the next thing to touch such an agent resumes it from the `{ version, data }` persistence blob under a fresh provider session ID, with `history: "replay"`, so what survives is whatever the adapter wrote into that blob — never an in-flight turn.

## Identifying the process a lock names

Signal 0 proves only that a PID is taken, and a PID outlives the process that earned it, so `ownsLock` has to establish who is actually behind it.

The command line alone cannot do it.
Matching the adapter's name and its entry file as free-floating substrings passes for the `claude` child — it is handed a `--settings` path carrying the adapter's name, and is itself `node <...>/cli.js` wherever Claude Code is installed as a bundle rather than as a binary — and for any bystander whose arguments merely mention the checkout.
So the command has to match as one path, `<...>/claude-tty-acp/<...>/cli.js`, and even then it says only what kind of process this is, never *which*: a second adapter that inherited the PID looks exactly like the first.
That pattern is built from the same names `server/paths.ts` registers the adapter under, so renaming either cannot leave a guard matching the old one behind.
It lives in `server/lock-owner.ts` rather than beside the session join, because `shared/sessions.ts` is bundled into the client and `server/paths.ts` reaches for `node:os` and `node:path`, which `shared/` may not.

The start time is the half that settles it.
Two live processes cannot share a PID, so a process that was already running when the lock was written and still holds that PID is the process that wrote it.
`/proc/<pid>/stat` field 22 against `/proc/uptime` gives it, `ps -o lstart=` gives it elsewhere, and both need slack — `ps` truncates to the second and a boot-time reading drifts against the wall clock, while PIDs take far longer than seconds to come round again.
`/proc` also reports the zombie state, which is worth its own sentence to the user: a process waiting to be reaped cannot be stopped and has not been left running.

Identity is proved again before the `SIGKILL` escalation, because the adapter may have exited during the wait and something else may hold the PID by then.
Concurrent stops of one session are coalesced onto a single promise: the adapter registers its handler with `process.once`, so a second `SIGTERM` arriving mid-shutdown takes the default action and kills it before it can release its lock.

## Agent titles are a courtesy and are budgeted like one

A session row is named after the Paseo agent holding it, joined on the ACP session ID: the daemon stores it as an agent's `runtimeInfo.sessionId` and `persistence.sessionId`, and it is this plugin's file stem.
`paseo.agents.list()` answers with the daemon's `{ agent, project }` entries, and the SDK types say so: its `entries` are `FetchAgentsEntry`, which is that wrapper and not the agent itself.
A bare agent is read as well, but only as tolerance for a shape the SDK has never handed over — not because the types and the wire disagree.

The lookup never gates a decision.
Mutations read the state directory through `readState`, which does not touch the daemon; only the payload handed back is decorated.
It is also raced against a budget and paged explicitly, because the SDK waits a minute by default while the daemon kills a plugin RPC at 30 seconds, and one page is capped at 200 agents.
A daemon that stalls or pages forever costs the titles and nothing else, which is the whole claim.

## Opening an agent, and the one thing a surface still cannot reach

`navigation.openAgent({ agentId })` is on `PluginSurfaceProps` and reveals an agent's terminal; the sessions rows use it.
It is optional in the type because a host older than 0.7 passes none, so the button is hidden rather than dead when it is absent — as it is for a session the daemon no longer lists an agent for.

`openSurface` and `openSettings` are the other half and are **not** on a surface's props: they live on command contexts and on the client entry's context.
So the panel cannot send anyone to this plugin's own settings screen, and the Command Center item is what does.

## A subagent is a subsession, and the daemon is strict about how one is opened

A subagent is a loop inside its session's Claude process rather than an ACP session, so `runAcpProvider` has no way to describe one: it maps ACP session updates and nothing in that protocol carries a child session.
0.8's `session.subsession` is what makes one showable anyway, and it is negotiated in `server/subsessions.ts`, a wrapper around the connection the shim returns, the way `server/permission-bridge.ts` wraps it for the two permissions that ask a person something.
The wrapper adds the capability to what the connection reports *and* to every `session.opened` the adapter emits, because the daemon checks both and they are never allowed to disagree.

A child is a `session.opened` carrying `parentSessionId`, and the daemon does not make it an agent: `PluginAgentClient.acceptChild` attaches it to the *root* session as a `ProviderSubagentDescriptor`, which is the same surface OpenCode's subagents use — a title, a description, a cwd, a status, and a timeline of its own, fetched over `agent.provider_subagents.*`.
There is no tab, no row in `paseo ls`, and no CLI for it at all; the app is the only client that shows one.
A child's `toolCallId` stays null whatever we do, because `acceptChild` builds its upsert from the `session.opened` alone, so nothing links the descriptor to the card in the conversation.
`restoration: "parent"` is what says the child persists nothing: closing it then removes it locally instead of sending `session.close` to a session the adapter has never heard of.
`capabilities: []` is the honest reading of a subagent — the daemon offers a child session no way to be prompted, and the agent behind it answers to the one prompt its launcher handed it.

Two ways of getting it wrong take the **whole connection** down, and with it every agent on this provider (verified against a 0.8.0 daemon with a throwaway plugin): a child whose parent's `session.opened` did not carry the capability, and a child for a parent the daemon has already forgotten.
It forgets one as it accepts a `session.close` and again as it publishes `session.closed`, so the wrapper tracks a parent between those two points and emits nothing about it outside them — and closes that parent's children *first*, on the way past, because a child left open then would go on saying it was working for as long as the agent existed.

What a subagent did is read off the disk, because that is the only place it is written: Claude writes a subagent's turns to `<projects>/<claude session id>/subagents/agent-<agent id>.jsonl`, never into the session's own transcript.
Which Claude session an ACP session is on is in the adapter's state file and nowhere else, and it moves under a compaction, so it is resolved on every poll rather than once.
Beside each transcript is an `agent-<agent id>.meta.json` carrying `agentType`, `description`, `spawnDepth` and — the reason it is read at all — the `toolUseId` of the call that launched it.

That id is the whole lifecycle. **The session's own transcript is not read here at all**: a launch left open in it says only that nobody was there to hear the end of it, never that the agent is still working, which is the bug the old panel had.
The tool call in the session's conversation says it properly, because the adapter closes one when the agent reports *and* when the Claude process it ran in stops, and the wrapper sees every `timeline.item` on its way to the daemon.
So a child opens while its launch is running and closes when that launch does — completed as a clean finish, anything else with an error, which is what a descriptor can say.
An agent whose launch has already ended when its transcript is found is history and is skipped; an agent another subagent launched names a `toolUseId` the session's conversation never mentions, so it is skipped too and stays on its spawner's card.

The transcript is read incrementally, the way the adapter reads the session's own, because it runs to megabytes and this polls once a second per open session.
Nothing rewrites a subagent's transcript, so a rewind can only be a truncation, and the tool calls sent as running are forgotten with it; the ones still open when the agent stops are canceled rather than left running.

## A module's directory picks its bundle

`index.client.tsx` and `index.server.ts` are compiled separately, and the directory a module sits in decides which bundle it joins: `client/` the app's, `server/` the daemon's, `shared/` both.
Reaching across that line is a compile error rather than something the compiler quietly filters away, so the entries import only their own side, and a module left at the plugin root fails the build.
`shared/` is the strictest of the three: no Node, no React, and no runtime-specific SDK entry, which is why everything here that computes a path or reads the disk is server-side however little it does.
Each entry default-exports one contribution function returning cleanup, and RPC names must match `^[a-z][a-z0-9._-]*$`.

## The rows are the host's; what is left is what the host has no component for

Sections, cards and rows come from `@getpaseo/plugin/client/ui`, which the compiler keeps external and the app supplies, so they are the host's own components rather than a copy that drifts.
Two of their behaviours decide how everything here is written: `SettingsCard` draws the divider between its children itself, so nothing passes a `divided`, and `SettingsRow` renders `children` as the control at the right of the row while `label`, `hint` and `error` stack on the left.
`error` is the row's danger colour and is announced, which is why `ReadingRow` puts a bad reading there and a good one in `hint`; there is no leading slot and no way to colour a `hint`, so the tone dot moved into the control.

What remains in `client/ui.tsx` is what the host exports no equivalent of: a bare `Button` (its own is only ever a `SettingsAction`'s), a `Disclosure` (built on `SettingsCard`, whose divider then appears exactly while it is open), a `StatusDot` and the mono font.
`client/theme.ts` is down to the metric scales the host does not hand over and the two shades its components are written against but do not expose.
Build new controls out of those tokens rather than out of literals.
Icons, `Modal`, `useToast` and `copyText` come from `@getpaseo/plugin/client/react-native`; nothing here draws its own dialog or icon.

## Tests

`pnpm test` is `node --test "{client,server,shared}/**/*.test.ts"` through Node's type stripping, so no TypeScript that has to be emitted and relative imports keep their `.ts` extension.
A test that resolves the plugin root walks up from `import.meta.dirname`, so it counts the directory it sits in and no `src/` above it.
`@getpaseo/client` is on 0.8.0 across the workspace, which is what `@getpaseo/plugin` takes as a peer.
