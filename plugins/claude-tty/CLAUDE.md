# Working on this plugin

Read `docs/adr/` before changing how the provider, the adapter process, settings, tool cards or question cards work.

## Checking a change

Run `paseo plugin reload claude-tty`, then `paseo plugin logs claude-tty`, after every change, yourself.
A reload stops Claude in every session on the provider, other people's included.
When someone else's sessions are on it, work in the `claude-tty-dev` copy (README, "A second copy to develop against"), or compile without reloading: run `compilePlugin` from the installed `@getpaseo/server`'s `dist/server/server/plugins/compiler.js` over the two entries.

To see what a handler really does on this host, call it over the daemon's plugin RPC with `connectToDaemon` from the installed `@getpaseo/cli`'s `dist/utils/client.js`:

```js
const client = await connectToDaemon({});
console.log(await client.invokePluginRpc("claude-tty", "claude-tty.status", {}));
```

The adapter logs to `~/.local/state/claude-tty-acp/logs/claude-tty-acp.log`; Paseo drops its stderr.
A running adapter keeps the code it started with, so a rebuilt `apps/claude-tty-acp/dist/` reaches only sessions started after it.

`pnpm identity <id>` stamps the plugin ID into `paseo-plugin.json`, `shared/identity.ts` and the adapter's `APP_NAME`; change the ID only through it, and let `pnpm identity --check` confirm they agree.

## Contracts with the adapter

The plugin and `apps/claude-tty-acp` share names and shapes with no type linking them, so change both sides in one commit.
The plugin side of each is marked "Mirrors the adapter's own …"; they include:

- the `_claude_tty/tool_call`, `_claude_tty/notice`, `_claude_tty/card_withdrawn` and `_claude_tty/model` vendor methods
- the `_meta["claudeTty/backgroundCommand"]` mark and the `claudeDialog` input marker
- the `--settings-file` and `--answers-dir` flags, and the snapshot shape `--settings-file` points at (`server/settings-snapshot.ts`)
- the output of `--diagnose --json`, which `server/doctor.ts` parses
- the `submit` and `reply-in-chat` option IDs, and the tool name carried in a permission's `toolCall.title`
- the state directory name, its session and lock files (`shared/sessions.ts`), and Claude's config directory (`server/paths.ts`)

## Provider registration

- Call `registerProvider` synchronously in the contribution: the daemon connects the provider milliseconds after the plugin reports ready, before any RPC hands it a `PaseoApi`.
- The server bundle has no `__dirname` and `import.meta` compiles to `{}`; the checkout is found through `$PASEO_HOME/config.json` (`server/checkout.ts`).
- Leave `command` off the registration. With one, the daemon launches its own command in place of `resolveAdapter`'s, and **Adapter executable** stops working.
- `status()` and `getCatalogCacheKey()` run on nearly every provider snapshot. Keep each to one settings `read()` and one `stat`; never spawn the adapter from them.

## Session events the daemon is strict about

- **Tool cards need the update twice.** The bridge draws a card from the ACP update alone as raw JSON; `server/tool-details.ts` fills it from the `_claude_tty/tool_call` copy, which the adapter sends *before* the update. Sent after, or returned as a timeline item from the hook, it is overwritten by the bridge's own item.
- **A cancelled tool call is `canceled`, never `failed` with a null error.** One `failed` item without an error makes the client refuse the agent's whole timeline ("Couldn't refresh agent history"). The bridge produces these on every cancelled turn, and `server/tool-call-outcomes.ts` repairs them; on the adapter side, every failed `tool_call_update` carries `rawOutput`.
- **Offer `prompt.steer`, then decline every steer with a `failed` result** (`server/steering.ts`). Leaving the capability off makes the daemon throw and drop a mid-turn message; a declined steer makes it cancel the turn and send the message as the next one.
- **Withdraw a card by answering it** with a plain deny through a `session.permission` input (`server/session-notices.ts`). Emitting only `session.permission_resolved` leaves it in the bridge, and the daemon resurrects it the next time any card is answered. Answer only cards still pending: an unknown one becomes `session.runtime_failed`, which the daemon reads as the session falling over.
- **The bridge's `config` update replaces the whole `ProviderConfigState`.** To move one field, such as the model Claude fell back to, send the last published state with that field changed.
- **Pickers come from `configOptions`.** The bridge takes the first option with `category: "model"` and the first with `"thought_level"`; any other option becomes a settings row. The adapter also publishes `models` for the daemon's own bridge, so keep both.

## Question and plan cards

- Paseo's question form draws nothing, and the permission can't be answered, unless every question has a string `question` and `header` and every option is an object with a string `label`.
- The form keys answers by `header`, so headers go out made unique and answers are mapped back to the question text.
- Submit sends a bare allow, which the bridge resolves to the *first* affirmative ACP option, so the adapter keeps `submit` first and gives it no answer of its own. Dismiss lands on the first declining option, `reply-in-chat`, the same way.
- Write the answers under `--answers-dir` before forwarding the response, so the adapter finding none means nobody answered.

## Subsessions

- Add `session.subsession` to the connection's capabilities *and* to every root `session.opened`. A child whose parent lacks it, or whose parent the daemon has already closed, takes the whole connection down with every agent on it.
- Close a parent's children before passing on its `session.close`.
- A child's lifecycle is its launching tool call's. A launch that ends `canceled` decides nothing: Paseo cancels the turn on every mid-turn message while the subagent keeps running.

## Sessions panel

- `server/sessions.ts` signals only a PID it has proved owns the lock (command path plus start time, `server/lock-owner.ts`), and only a positive one: 0 and negatives signal process groups, and the adapter shares the plugin's group.
- Coalesce concurrent stops of one session: the adapter's SIGTERM handler is `process.once`, so a second SIGTERM kills it before it releases its lock.
- The daemon kills a plugin RPC at 30 seconds and `paseo.agents.list()` waits a minute by default, so agent lookups run on a budget and never gate a mutation.
- `paseo.agents.list()` returns `{ agent, project }` entries, not agents.
- The daemon's `PATH` is not your shell's; report a spawn failure as a sentence for the panel, not a stack trace.

## Settings

- `subscribe()` fires on saves, resets and migrations, not on hand edits of the settings file.
- Only `connect()` creates the snapshot's directory, so a settings save cannot recreate state that **Danger zone** just deleted.

## Client UI

- `SettingsCard` draws dividers between its children itself. `SettingsRow` renders `children` as the control on the right, with `label`, `hint` and `error` stacked on the left; `error` is the danger colour.
- A screen's props have no `openSettings` or `openScreen`; the Command Center item is how the panel reaches the settings screen.
- Build controls from `client/theme.ts` tokens and `client/ui.tsx`; icons, `Modal`, `useToast` and `copyText` come from `@getpaseo/plugin/client/react-native`.

## Tests

- Tests run through Node's type stripping: relative imports keep their `.ts` extension, and nothing may need emitted TypeScript.
- `server/acp-provider.test.ts` builds the adapter and spawns it.
- `server/daemon-permissions.test.ts` runs against a real `@getpaseo/server` and skips without one: `PASEO_SERVER_DIST=<installed @getpaseo/server> pnpm test`.
- The canary tests assert upstream bugs. When one fails because Paseo fixed the bug, delete the workaround it guards.
- Keep `@getpaseo/client` on the version `@getpaseo/plugin` takes as a peer.
