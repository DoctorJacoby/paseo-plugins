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

## The adapter stays a subprocess, and `connector:` cannot replace it

`RunAcpProviderOptions` takes a `command` or a `connector`, and the second would run the adapter inside the plugin's own process — no PID, no lock file, no Stop button, none of `server/lock-owner.ts`.
It is not on, and the reason is not native modules: the plugin bundle's injected `require` falls through to a real `createRequire` bound to the daemon's path, so a runtime-computed absolute specifier reaches node-pty's prebuild.

The reason is the environment. `AcpConnector` is `() => AcpStream`, called with **zero arguments** — measured — and on that branch nothing ever reads an env: only the `command` branch spawns with `{ ...process.env, ...options.env }`, and the `_meta._paseo` blob on `session/new` carries `systemPrompt`, `providerOptions`, `toolPolicy` and `persist` and no env either.
`ProviderSessionConfig.env` is where the daemon puts `PASEO_AGENT_ID`, the adapter hands it straight to the Claude PTY, and the `glab` wrapper's bot-identity swap keys on exactly that.
In process, `process.env` is the plugin worker's — one environment shared by every session, with no agent id in it — so every agent would post to GitLab as the person running the daemon.

The blast radius is the second reason. Plugin server code runs in a forked child, so a native crash does not take the daemon down — but on child close the daemon fails every provider connection, **removes the plugin**, and closes every agent on it, with no automatic restart anywhere in its plugin runtime.
Today one wedged adapter is one wedged session with a Stop button.
`connector` is also undocumented: `public-docs/plugins/v0.8/*` shows only the `command` form.
Revisit only if a future SDK gives `AcpConnector` a context argument carrying the session config.

## The pickers are config options, and the category decides which picker

The bridge `runAcpProvider` returns builds the whole of `ProviderConfigState` from the session's `configOptions`: `toProviderConfigState` takes the *first* option with `category: "model"` as the model picker and the first with `category: "thought_level"` as the thinking one, and everything else — an absent category included — becomes a `settings` row.
`modes` is the exception and comes only from the ACP `modes` state, so a `category: "mode"` option would be shown as a setting rather than merged into the mode picker; the adapter publishes none.
Groups are flattened and an option's `description` is dropped for both pickers, which is why the descriptions worth keeping are on the modes.

The v1 `NewSessionResponse` this bridge parses has no `models` field at all, so an adapter answering the older way gets an empty picker and a `session.open` naming a model fails with "ACP session does not expose model configuration".
The daemon's own bridge is the other way round — it prefers `models.availableModels` and reads only the thought levels out of `configOptions` — so the adapter answers with both, and both are exercised: `server/acp-provider.test.ts` drives `runAcpProvider` as a library against the built adapter and asserts the catalogue and a session opened on a named model.

## A tool call arrives twice, because once is not enough to draw its card

`toolTimelineItem` in the SDK's ACP connection is the whole of that bridge's card-building: `kind === "edit" || name.includes("edit") ? edit : unknown`, over a snapshot `mergeToolCallSnapshot` has already built without the ACP `content` blocks.
The daemon's own bridge builds eight shapes out of exactly the data that is missing — `mapToolDetail` reads `kind`, the `content` blocks and the `locations` — so the plugin provider would have shipped every shell command, search and subagent log as raw JSON, which is a regression against what a claude-tty session shows today.

None of the four `AcpTransformer` hooks closes that on its own.
`toolCall` receives a snapshot with no `content` on it — measured, `"content" in snapshot === false` — and returns another snapshot, which goes through `toolTimelineItem` anyway; `notification` never sees a `session/update`, because `routeVendorNotifications` diverts only methods the ACP SDK does not know and `session/update` is one it does.

So the adapter sends a copy of each tool-call update over the vendor method `_claude_tty/tool_call`, `server/tool-details.ts` keeps it from a `notification` transformer, and the wrapper in the same file puts the card it describes onto the item the bridge emits for that call.
The mapping is a port of the daemon's `mapToolDetail`, so the two bridges draw the same card; the terminal content block is the one branch left out, since it needs ACP terminals the adapter does not implement.

It is a wrapper rather than the `{ type: "timeline", item }` that hook can return, and the reason is ordering.
A vendor notification is handled where it sits in the stream, synchronously, while a `session/update` goes onto a notification lane of its own — measured with a fake in-process agent: an item returned from the hook is emitted *before* the bridge's own item for that call, and the bridge's `unknown` then overwrites it.
The copy is sent ahead of the update rather than behind it for the same reason: behind, it still arrives first, but only by the depth of that lane, which is whatever one read off the pipe happened to carry.

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

## There is no way to open an agent from here

`openSurface` and `openPanel` live on command contexts and on the client entry's context, never on a surface's props, and the only `openPanel` target is a panel this plugin contributes.
Paseo has a `{ kind: "agent" }` navigation target of its own but does not expose it, so nothing a plugin can call reveals an agent's terminal.
An "open" button built on the client entry and an agent panel was tried and removed: the closest the API reaches is opening a tab that shows the same row the sidebar already shows, which is worse than sending someone to the agent list.

## A subagent is not a session, and its work is in another file

Claude writes a subagent's turns to `<projects>/<claude session id>/subagents/agent-<agent id>.jsonl`, never into the session's own transcript, which carries only the launch and — for an asynchronous agent — a `<task-notification>` saying it stopped.
So both files are read: the session's for the launch metadata Claude leaves beside the tool result (`toolUseResult.agentId`, and `status: "async_launched"` for one that has only started), and the subagent's for anything it actually did.
Claude also writes an `agent-<agent id>.meta.json` beside each transcript carrying the description, the tool use that launched it and its `spawnDepth`, which is the only thing that names a subagent another subagent launched, because the session's transcript never sees one.
An asynchronous launch answers its launcher immediately, so a tool result is not proof the agent finished; the notification is.
Claude writes that notification into the turn it wakes for when the agent reports to an idle session, and into a `queued_command` attachment when it reports to one that is mid-turn, so both are read; a session whose process stops first writes neither:
a launch left open in a finished transcript says only that nobody was there to hear the end of it, never that the agent is still working.

The panel lists only open sessions, because a subagent is a loop inside its session's Claude process and stops with it, and it is not an ACP session or a Paseo agent, so the paragraph above about opening an agent applies to it twice over.
An asynchronous launch with no notification after it reads as running in the panel, and nothing on disk says whether the Claude process behind it is still the one that launched it.
So an agent launched before a suspension or a model change stays listed as running until its session closes, with the last-step label as the only sign, while the adapter closes its card in the conversation because it knows the process stopped.
Both files are read incrementally from module scope, the way the adapter reads them, because each runs to megabytes and the panel polls: what is new is parsed onto what was already read, a rewrite is noticed by comparing the head of the file rather than its length, and only the tail of steps the panel shows is kept.
Module scope lives as long as the plugin process, so everything it holds is keyed by the session directory it was read for and dropped as soon as that session is no longer open.

## A module's directory picks its bundle

`index.client.tsx` and `index.server.ts` are compiled separately, and the directory a module sits in decides which bundle it joins: `client/` the app's, `server/` the daemon's, `shared/` both.
Reaching across that line is a compile error rather than something the compiler quietly filters away, so the entries import only their own side, and a module left at the plugin root fails the build.
`shared/` is the strictest of the three: no Node, no React, and no runtime-specific SDK entry, which is why everything here that computes a path or reads the disk is server-side however little it does.
Each entry default-exports one contribution function returning cleanup, and RPC names must match `^[a-z][a-z0-9._-]*$`.

## The panel is styled off paseo's own scale

`client/theme.ts` and `client/ui.tsx` are copies of the Discord plugin's, because the host hands plugins no metrics and each plugin directory has to bundle from its own root.
Build new controls out of those tokens rather than out of literals, and keep the two files in step with their originals.
Icons come from `@getpaseo/plugin/client/react-native`, by Lucide name; nothing here draws its own.

## Tests

`pnpm test` is `node --test "{client,server,shared}/**/*.test.ts"` through Node's type stripping, so no TypeScript that has to be emitted and relative imports keep their `.ts` extension.
A test that resolves the plugin root walks up from `import.meta.dirname`, so it counts the directory it sits in and no `src/` above it.
`@getpaseo/client` is on 0.8.0 across the workspace, which is what `@getpaseo/plugin` takes as a peer.

`server/acp-provider.test.ts` is the one exception to all of that: it runs the adapter's own `tsc` build and then spawns the result, because the bridge it exercises takes a command rather than a module, and a stale `dist/` would otherwise decide the result.
It points the adapter at a throwaway state directory so the run touches none of yours.
