# Working on this plugin

Run `paseo plugin reload claude-tty` after every change, then `paseo plugin logs claude-tty`.
Do this yourself; never leave it to the user.
Where a reload is not available — another agent's sessions are on this provider, say — the daemon's own compiler answers the same question without touching it: import `compilePlugin` from `@getpaseo/server/dist/server/server/plugins/compiler.js` and run it over the two entries, then `readPluginProviderIcon` from `provider-icon.js` beside it for the icon.
That log is the plugin's; the adapter's is `~/.local/state/claude-tty-acp/logs/claude-tty-acp.log`, because the daemon drops the adapter's stderr, and a running adapter process keeps the code it started with — a rebuilt `dist/` reaches the sessions started after it.

`paseo plugin add <repo> --path plugins/claude-tty` is the supported install: the daemon clones into a staging directory, runs the manifest's `build` commands there with the plugin directory as the cwd, and only then places and starts it.
`pnpm` walks up to the workspace root from that cwd, which is why `pnpm install --frozen-lockfile` and `pnpm --filter @paseo-plugins/claude-tty-acp build` are enough (verified by running both from `plugins/claude-tty`).
A directory install runs no build at all, so a clone has to be built by hand before it is added.
Which is also why the ID is stamped into the checkout by `pnpm identity <id>` (`scripts/set-identity.mjs`) rather than generated: there is no build step to generate it in on the path that matters, and a generated file would be missing exactly where it is needed.
It writes `paseo-plugin.json`, `shared/identity.ts` and the adapter's `APP_NAME` — the places the ID has to appear, none of which can read another — and `pnpm identity --check` is the guard; stamping the ID a checkout already has is a no-op to the byte.
A second checkout stamped `claude-tty-dev` is the better answer to the reload problem above when somebody else's sessions are running: see the README's "A second copy, to develop against".

To exercise a handler without a client, invoke it over the daemon's own plugin RPC:

```js
import { connectToDaemon } from "/usr/lib/node_modules/@getpaseo/cli/dist/utils/client.js";
const client = await connectToDaemon({});
console.log(await client.invokePluginRpc("claude-tty", "claude-tty.status", {}));
```

That is the only way to see what a filesystem guard actually does, so use it rather than reasoning about the code.

## The checkout is not discoverable, and the daemon asks for the provider before it can be

By default the plugin runs the adapter built inside the checkout it was installed from, and nothing in the plugin runtime says where that is.
The server bundle is `eval`'d from a string in a wrapper taking only `require`, so it has no `__dirname`, and esbuild compiles `import.meta` to `{}`; the daemon's initialize message carries `pluginId`, `appVersion`, `bundle` and `settingsDirectory` and no path.
The daemon's own configuration is the one record, so `server/checkout.ts` reads `$PASEO_HOME/config.json` — the plugin process inherits `PASEO_HOME` from the daemon — rather than asking over `paseo.config.get()`, because `registerProvider` has to be called synchronously during the contribution and the daemon connects the provider about ten milliseconds after the plugin reports ready, long before any RPC has handed the plugin a `PaseoApi`.
`apps/claude-tty-acp/package.json` has to exist two levels above the plugin directory before that answer is worth anything.
`server/paths.ts` is the naming vocabulary that resolving builds on and computes paths without touching the disk.

**It is no longer the only source, and failing to find it is no longer fatal.**
`adapterExecutable` in the host settings names an adapter outright, and `server/adapter.ts` is the one place that decides between the two: the setting when it holds a path, the checkout otherwise, and neither is the end of the world on its own.
It reads the setting off the document at `settingsFilePath` rather than asking the store, for the same reason the adapter is handed that path — `registerSettings` returns `void` and nothing hands a value back — and a document that is missing, unreadable or malformed reads as nothing configured, because the store writes the file only once somebody saves and refusing to run over a JSON parse would be every session on the host.
Nothing in there throws: a path that is missing, unexecutable or unbuilt comes back as a sentence on `problem`, which the panel shows and `connect()` throws only when there is no path at all.
The checkout is still resolved and still reported, because an update still builds in it and a host running the default still wants to see it.

That is also why the resolution is no longer cached the way the checkout was.
The path the daemon loaded this plugin from cannot change under it; a setting can, so `resolveAdapter` reads the document every time and `getCatalogCacheKey` costs that read plus its one `stat`.

`connect()` is async, so the command is resolved per connection rather than at registration: `server/provider.ts` builds the `runAcpProvider` shim inside `connect` and delegates to it.
That shim spawns one adapter process per ACP session, plus a throwaway one per connection to probe capabilities and another per catalogue fetch, and it drops the adapter's stderr — which is why the diagnostics section still runs the adapter's own `--diagnose`.

How often that catalogue fetch happens is `getCatalogCacheKey`'s to decide.
Without it the daemon keys the cache on `["target", <cwd>]` and fetches once per distinct workspace directory, which on a machine that spawns worktrees is once per worktree; with it, equal keys share one fetch across every directory.
The key is the adapter's build — the build witness's path, mtime and size, one `stat` — rather than a bare constant, because the catalogue is compiled into the adapter and a rebuilt adapter is where a different one comes from; a constant would serve the old catalogue for the rest of the daemon's life.
`adapterBuildWitness` is what "the build" means for a path: the executable in a checkout is a committed shell wrapper whose mtime never moves, so the `dist/cli.js` it runs is the file to watch, while a configured executable is its own witness because there is nothing else here to know about it.
Nothing else invalidates it. The daemon refetches when something asks it to refresh (`force`), and marks catalogues stale when the settings snapshot is refreshed; there is no expiry.
It is a separate IPC call on essentially every provider snapshot read, so it must stay at the settings document and one `stat`.
An adapter that is not built yet answers with a shared key of its own rather than with none, so that failure is reported once instead of once per workspace, and the build that fixes it changes the key.

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

## A message sent mid-turn needs `prompt.steer` offered, and then turned down

`public-docs/plugins/v0.8/providers.md` says to omit `prompt.steer` when steering is unsupported, so that Paseo can replace the active turn instead. The 0.8.0 daemon does not do that.
Every plugin session has a `steerActiveTurn`. The app's composer sends a mid-turn message with `activeTurnBehavior: "steer"`, and so does the daemon when an agent reports back to its caller, and both reach that method.
It checks the session's capabilities first and *throws* `Provider does not support prompt.steer`, so the message is never sent and no turn is replaced.
Only an *answered* steer that is not `{ type: "steer" }` for the running turn counts as `unavailable`, and `unavailable` is what makes the daemon interrupt the turn and send the message as the next one.
Upstream `main` behaves the same as of 2026-09-11.

The bridge cannot steer either: `admitPrompt` cancels an active prompt before it forwards any new one, and the adapter refuses a second `session/prompt` while a turn is open.
So `server/steering.ts` offers the capability, on the connection and on every root `session.opened`, and answers each steer with a `failed` result without forwarding it.
Paseo's own `provider-direct` example uses the same answer when there is no turn to steer.
On a throwaway 0.8.0 daemon with a fake ACP agent, the unwrapped provider reproduced the throw, and the wrapped one produced `session/cancel` and then `session/prompt` with the message, with both user messages in the timeline.
That is what the daemon's config-file ACP providers get, since they have no `steerActiveTurn` at all.
Claude absorbing a message into the running turn, the way it does with text typed into its terminal, would need a path to the adapter that avoids the bridge's prompt admission, and there is none.

## A tool call cancelled with the turn has to be `canceled`, not `failed`

A `failed` tool call must carry a non-null error: `ToolCallFailedPayloadSchema` in `@getpaseo/protocol` is `error: NonNullUnknownSchema`, while the other three statuses take `error: null`.
An item that breaks that is not dropped on its own — the whole `fetch_agent_timeline_response` fails validation, so the client refuses the *entire* history of that agent, and goes on refusing it for as long as the item is in the timeline.
It shows as "Couldn't refresh agent history", with nothing logged on either side, on a session that is otherwise working perfectly. `paseo logs <agent>` reproduces it from the CLI.

The bridge makes one on every cancelled turn. In `acp-internal/connection.js`, `terminalizeTransientItems` is handed `"canceled"` or `"completed"` and maps anything that is not `"completed"` to `"failed"`; `toolTimelineItem` then takes the error from `snapshot.output`, which a call that was still running never wrote.
So `{ status: "failed", error: null }`, from a state the bridge had the right word for and threw away — the schema's fourth status, `canceled`, takes a null error.
Paseo cancels a turn before it replaces one, and `server/steering.ts` makes that the path of every message sent mid-turn, so in a session with a subagent running this is one message away at any time.

`server/tool-call-outcomes.ts` turns a failed tool call carrying no error back into a cancelled one. A genuine failure always carries its output as its error, so a failed call with none did not fail: it was still running when its turn ended.
Its test drives the real bridge, and the canary beside it asserts the bridge's own behaviour, so both fail the day this is fixed upstream and the wrapper can go.
The adapter had the same hole of its own: `settleOpenToolCalls` and a failed subagent card sent `tool_call_update` with no `rawOutput`, which is the same null error by the same route, and both now send one.

## The host owns the settings, and the adapter is told where they are

`registerSettings` hands the daemon a schema and nothing else: it returns `void`, `PluginServerContext` has no way to read a value back, and the `settings.changed` the store emits travels to the *clients* — `subscribeSettings` in the daemon's `session.ts` turns it into a `plugin_settings_changed` broadcast — never back into the plugin runtime.
So there is no watcher to hang a mirror file off, and this plugin neither reads nor writes the document.

The store runs inside the plugin's own subprocess and keeps one file per definition at `$PASEO_HOME/plugin-settings/<plugin id>/<settings id>.json`, holding `{ "version", "values" }` where `version` is the definition's rather than the file format's.
Verified on a 0.8.0 daemon with a throwaway plugin: a missing file reads as the schema's defaults at revision `missing`, a write lands that envelope, and `paseo plugin remove` deletes the directory.
`server/paths.ts` rebuilds that path from `PASEO_HOME`, the way `daemonConfigPath` already did.

The adapter is a detached process the ACP shim spawns, so it is handed the path as `--settings-file` in the command `connect()` builds, and re-reads it at every suspension.
The alternatives were both worse: `runAcpProvider` takes no `env`, and a value passed at spawn would only reach the next adapter rather than the sessions already open, which is the behaviour the idle timeout is documented to have.

The setting is global, not per session, and it is now a choice rather than the only option.
A per-session `ProviderSetting` is only ever *listed* from the ACP session's own `configOptions` — `toProviderConfigState` in the SDK's ACP connection builds `settings` from every option whose category is neither `model` nor `thought_level` — and the adapter does advertise config options since it started publishing its model and effort selectors, so the `session/set_config_option` surface that was missing is there.
What is left is the trade: an uncategorised option beside those two would put the timeout in the session's own configuration and take it out of the store Paseo owns, so it would stop surviving a reload, stop being one answer per host, and stop being deleted with the plugin. That is why it stays where it is.

## An upgrade leaves two things behind, and only one of them is the plugin's to fix

Before this plugin registered a provider of its own, it wrote the adapter into the daemon configuration as `agents.providers.traecli`, and kept the idle timeout in `${XDG_CACHE_HOME:-~/.cache}/paseo-plugins/claude-tty/settings.json` as `{ version: 1, settings: { idleTimeoutMs } }`.
Nothing about the plugin provider touches either, so `server/upgrade.ts` deals with both.

The old entry is reported, never removed.
An agent started on it cannot resume once it is gone, whether those agents are finished with is not the plugin's to judge, and removing it would bring back `paseo.config.patch` for that one purpose.
`traecli` is also the real Trae CLI's ID, so only an entry whose command's basename is `claude-tty-acp` counts.
The status RPC carries it with a count of the agents still on it, from `paseo.agents.list()`, which leaves archived agents out; the count is null rather than partial when the listing runs out of budget, since a short count reads as safe to remove.
The agents are listed only while the entry exists, so the five-second poll costs one configuration read on every other host.
The app offers **Remove provider** under Settings → Providers only for a provider whose `source` is `custom` (read out of the web UI bundle), which is the old entry and never this plugin's, and that is where the panel and the README send people.

The idle timeout is copied, once, when the plugin process starts, because nothing in the store API can do it.
`registerSettings` returns `void`, and a definition's `migrate` runs only on a stored document with an older `version`, never on a missing one.
But the store keeps nothing in memory: it reads its file on every read and every write, and a revision is the hash of the bytes on disk (0.8.0's `plugins/settings/index.js`), so a document written beside it is what the settings screen and the adapter see next.
No `settings.changed` goes out for it, which only a screen opened within milliseconds of the plugin starting could notice.
It is written to a temporary file and `link`ed into place rather than renamed, because `link` refuses an existing target and a value saved in Paseo in the meantime must win.
The old file is deleted once the host has a document, whoever wrote it, so a reinstall — which deletes the document and starts from defaults — cannot bring a stale value back; it is kept only when writing failed, for the next start to try again.

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

## A card cannot be taken back, so the plugin ends it on the daemon's side

ACP permissions only ever end at the client: the agent sends `session/request_permission` and waits, nothing in the protocol withdraws one, and the bridge's own `permissions` map is cleared only when the transport closes.
That is fine for everything a hook asks, because Claude is blocked on the hook until somebody answers.
It is not fine for the cards the adapter raises for Claude's *own* terminal dialogs: Claude closes two of its nudges by itself after thirty seconds, and a prompt arriving closes whatever is open to get the keyboard back, so the card would be left standing for a question nobody is asking and nobody can make go away.

`server/session-notices.ts` ends it where it can be ended — the daemon — by **answering** it: the wrapper sends the bridge a `session.permission` input for `permission:<toolCallId>` with a plain deny, which is the same input the daemon sends when a person answers a card.
The bridge then does all of it — takes the entry out of its pending map, resolves the ACP request, and emits `session.permission_resolved` itself.
Emitting only that event is not enough, and was measured not to be: the card left `paseo permit ls` and came back as pending the next time any card was raised, because the bridge still held it and the daemon rebuilds the pending list from what the bridge reports.
The deny lands on the first declining option, which on every card the adapter withdraws is its Dismiss.

Answering a card that is *not* pending is not harmless, which is why the cards still open are tracked in that wrapper from the bridge's own `session.permission` and `session.permission_resolved` events: `respondToPermission` throws `Unknown ACP permission`, and `send` never rejects — `emitOperationFailure` turns it into `session.runtime_failed` for the session, which the daemon reads as the whole session having fallen over.
A withdrawal and a person can still answer the same card in the same instant, so a `session.runtime_failed` carrying that message is dropped on the way out; nothing else produces one, and it means a card was answered twice rather than that anything failed.

**A card left open does not merely go stale — it comes back.**
Two things in `@getpaseo/server` 0.8.0's `agent-manager.js` make that so, and together they are why the withdrawal has to reach the provider rather than only the screen.
`respondToPermission` refreshes the agent after every answered card, and `refreshSessionState` rebuilds `agent.pendingPermissions` wholesale from `session.getPendingPermissions()` — the plugin session's own map, which only `session.permission_resolved` ever empties.
And `cancelAgentRun`, which runs whenever Paseo interrupts a turn to replace it, calls `resolvePendingPermissionsForAgent`: that clears the *agent's* copy and tells the provider nothing at all.
So an interrupted turn hides a card, and the next card anybody answers brings it back — on top of whatever is on screen by then, answering a question that closed minutes ago.
A session was watched doing exactly that on 2026-09-16, resurrecting a `/model` card a prompt had closed a minute earlier.

That is what `server/daemon-permissions.test.ts` drives, against the daemon's own `PluginAgentClientRegistry` rather than an account of it, with the canary beside it that asserts the resurrection while Paseo still behaves this way.
The daemon is not a dependency here — it is what installs this plugin, and making it one would put it in front of every `pnpm install --frozen-lockfile` an install runs — so the test resolves `@getpaseo/server` if a copy is to hand and skips with instructions if not: `PASEO_SERVER_DIST=<path to an installed @getpaseo/server> pnpm test`.

The wrapper also ends the dialog card a session already had open when the adapter raises the next one.
A session holds one of Claude's questions at a time, so a card for a new one says the old one is over, whatever became of the withdrawal that should have said so — the backstop that makes the resurrection impossible rather than merely unlikely.
The transformer and the wrapper are built by one factory because the transformer is what hears the adapter's notification and the wrapper is the only thing that can reach the connection.

The model a session is on is the third thing in that file, and the third thing ACP has no word for: it carries a session's mode home over `current_mode_update` and nothing else about its configuration, so a model Claude swapped for itself — a message its safeguards flagged, retried on a fallback — has no way back to the picker.
The bridge's `config` vendor update is the route, but it replaces the whole `ProviderConfigState` rather than patching one field, and a transformer is handed no state at all.
So the wrapper keeps the last configuration the bridge published per session and the change is that snapshot with the model moved; a model the session's own catalogue does not list is ignored, since a picker set to an option it does not have is worse than a picker one switch out of date.
It is a reading rather than a decision — the adapter's launch flag is untouched, so restarting the session puts the model back to the one that was chosen.
The transformer and the wrapper are built by one factory because the transformer is what hears the adapter's notification and the wrapper is the only thing that can reach the connection.

The model a session is on is the third thing in that file, and the third thing ACP has no word for: it carries a session's mode home over `current_mode_update` and nothing else about its configuration, so a model Claude swapped for itself — a message its safeguards flagged, retried on a fallback — has no way back to the picker.
The bridge's `config` vendor update is the route, but it replaces the whole `ProviderConfigState` rather than patching one field, and a transformer is handed no state at all.
So the wrapper keeps the last configuration the bridge published per session and the change is that snapshot with the model moved; a model the session's own catalogue does not list is ignored, since a picker set to an option it does not have is worse than a picker one switch out of date.
It is a reading rather than a decision — the adapter's launch flag is untouched, so restarting the session puts the model back to the one that was chosen.

It is wrapped innermost of the four, directly around the steer fallback, so the event the bridge emits for it travels out through every wrapper above — `withPermissionCards` drops its own record of a card on exactly that event.

A notice is the easy half of the same file: `{ type: "notice", notice }` is a vendor update the bridge already turns into `session.notice`, which is a timeline notification rather than a message and sends no push.
It is how something that happened *to* a session gets said — a question of Claude's dismissed to deliver a prompt — and a notice missing an id or a title is dropped rather than drawn empty.

## Constraints that are not obvious

The daemon's `PATH` is not your shell's.
A systemd daemon typically has `/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin` and nothing else, so Claude is routinely missing from it.
That is a reading the surface reports, not an error to hide, and every spawn failure has to read as a sentence rather than a stack trace.

The plugin never builds the adapter itself; install and update do, through the manifest's `build`, a directory install leaves it to whoever owns the checkout, and a host that points `adapterExecutable` somewhere has built it however it likes.
The surface reports whether the build witness is there, and whether the executable exists and can be run, because that is what a spawn failure will otherwise say opaquely.

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
So a child opens while its launch is running and closes when that launch ends *for real* — completed as a clean finish, a failure carrying the error the adapter wrote as an error, which is what a descriptor can say.
A launch cancelled with its turn is neither and decides nothing: Paseo cancels a turn before it replaces one, so every message sent while an agent runs terminalizes the launch — the bridge marks it failed with no error, repaired to `canceled` only *outside* this wrapper — while the agent runs on and the adapter reopens the card as soon as it writes.
Closing the child on that made talking to a session mark its working subagents failed, which was this wrapper's own version of the old panel's bug.
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

`server/acp-provider.test.ts` is the one exception to all of that: it runs the adapter's own `tsc` build and then spawns the result, because the bridge it exercises takes a command rather than a module, and a stale `dist/` would otherwise decide the result.
It points the adapter at a throwaway state directory so the run touches none of yours.

## Auto Accept lives in the adapter

The daemon gives its own ACP providers an `auto_accept` feature and answers their permission requests itself; a plugin provider gets neither.
`ProviderSetting` also has no `icon` or `tooltip`, and the SDK's schema strips both, so the toggle shows with the app's generic settings icon.
So the adapter publishes the toggle as a boolean ACP config option, which `runAcpProvider` maps to a toggle setting and the daemon to an agent feature, and answers the `PermissionRequest` hook itself.
`paseo run` can set a mode but not a feature, and the daemon defaults nothing for a plugin provider's unattended create, which is why a session's starting value comes from the host settings rather than from whoever created it.
