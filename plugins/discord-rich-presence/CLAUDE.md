# Working on this plugin

Run `paseo plugin reload discord-rich-presence` after every change, then read `paseo plugin logs discord-rich-presence`.
The reload is the only compile check of the two bundles, so run it yourself rather than handing it to the user.
If a reload hangs on `Stopping plugin` until the 60s timeout, kill the lingering `plugin-process.js` that is still connected to the daemon port.

The server holds its own websocket to the daemon in `server/daemon.ts`; `docs/adr/0001-own-daemon-connection.md` says why.

New UI is built from the tokens in `client/theme.ts` and the controls in `client/ui.tsx`, which mirror Paseo's own controls in `packages/app/src/components/ui`.
`client/preview.tsx` uses Discord's colours on purpose, because it shows what Discord will show.

## Traps

**The daemon client id.** The daemon routes any client id starting with `plugin:` to its internal plugin session, and the websocket handshake then hangs forever without an error.
Keep `DAEMON_CLIENT_ID` free of that prefix.

**CommonJS dependencies.** The daemon's compiler rewrites esbuild's lazy CommonJS interop getters into eager reads (`makeHermesInteropEager`).
A CommonJS package, including anything built by tsup or esbuild, then exports `undefined` and fails at load with `class extends value undefined`; pre-bundling it does not help.
Use an ESM package, or write the code out yourself, as `server/ipc.ts` does for Discord's IPC protocol.

**Daemon data.** Three things the daemon's API does not tell you:
- `workspace.activityAt` arrives as null, so the daemon's `activity_at` sort ranks nothing and `rankWorkspaces` does the ranking.
- `agents.list({ scope: "active" })` still returns closed and archived sessions.
- The workspace focused in the app cannot be read: the daemon keeps the app's heartbeat private to the session that sent it.

**New settings fields.** Give every field added to `shared/settings.ts` a `.default()`.
Without one, every document saved before the field existed reads as `invalid`: the service keeps its previous settings and the panel shows an error instead of the settings.

**Tests run on Node's type stripping.** Keep the `.ts` extension on relative imports, and write erasable TypeScript in any module a test imports.
