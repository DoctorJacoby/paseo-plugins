# Claude TTY

Adds **Claude TTY** to Paseo's provider list: the genuine interactive Claude Code CLI, driven in a PTY by the [Claude TTY ACP adapter](../../apps/claude-tty-acp).

The plugin registers the provider itself and runs the adapter it was installed beside, so there is no provider entry to write into the daemon configuration and nothing to reload. It also diagnoses the adapter and manages its saved sessions from Paseo's sidebar, on whichever host is selected.

Owning the provider is also what lets Claude's own interactions use Paseo's cards for them. A question Claude asks becomes one question form holding every question at once — radio buttons, checkboxes where Claude allows several answers, and a box for an answer that is on none of the lists — and a plan becomes a plan card with Implement and Reject. Both are answerable from a terminal too: `paseo permit allow <agent> <id> --input '{"answers":{"Runtime":"Node"}}'` answers a whole form, keyed by the label each question shows.

Owning it is also what lets a subagent be more than a card. An agent a session launches opens as a **subsession** of the Paseo agent that launched it, with a timeline of its own: what it was asked to do, what it said, and every tool call it made, with the file it read, the command it ran and the reason anything failed — not the bounded tail the launching card has room for. A subsession takes no prompts, because the subagent behind it takes none: it answers to the one prompt its launcher handed it. It closes when the launch that started it does, which is also what a session whose Claude process stopped reports, so nothing goes on saying it is working after the process running it has gone.

Owning it is what gives a session its own pickers, too. The model list is Claude Code's rolling aliases and the releases behind them, and beside it is a **thinking** picker carrying Claude Code's effort levels, which claude-tty had no way to offer before. Either can be changed while a session is idle: the adapter restarts Claude on the same conversation with the new flag, so the choice is a real one rather than a message typed into the box.

An agent another agent launched has no subsession of its own: the session's conversation never mentions one, so nothing there says when it stopped, and its steps stay on its spawner's card the way they always did. The card is also all there is on a daemon that does not negotiate `session.subsession`, where nothing is emitted at all.

## Screenshots

_None yet._

## Installation

```sh
paseo plugin add sleeyax/paseo-plugins --path plugins/claude-tty
```

Paseo tracks the default branch from there, so `paseo plugin update claude-tty` picks up new releases without a clone. `paseo plugin status` says what is installed against what is available.

Install and update both build the adapter first, from the manifest's `build` commands, which is why this plugin needs `pnpm` on the daemon's `PATH` where the others need nothing. A failing build is reported and the installed version is left running.

Installing from a clone works too, and is what to do while developing the adapter — build it yourself first, since a directory installation runs no build:

```sh
pnpm install --frozen-lockfile
pnpm --filter @paseo-plugins/claude-tty-acp build
paseo plugin add "/absolute/path/to/paseo-plugins/plugins/claude-tty"
```

**An authenticated Claude stays yours to arrange.** Run `claude` interactively as the user the daemon runs as; the plugin never touches Claude's configuration, credentials, or transcripts.

Everything is host-local: selecting another host in Paseo shows that host's own answer, and each host is installed separately.

### Upgrading from the `traecli` provider

Earlier versions of this plugin, and the adapter's own README, registered the adapter in the daemon configuration under the provider ID `traecli`. This version registers a provider of its own, `claude-tty`, and `paseo plugin update claude-tty` leaves the old entry where it was, so Paseo lists Claude TTY twice. The panel says so under **Left over from an older install** for as long as the entry is there, with the number of agents still on it.

- **An agent stays on the provider it was started on.** Agents started on `traecli` keep using the old entry and cannot resume once it is gone, so remove it once none are left: under **Settings → Providers** on that host it is the Claude TTY entry with an actions menu, and **Remove provider** deletes it from the configuration. The plugin never removes it itself.
- **The provider ID changes.** Anything that names `traecli/<model>` — a spawn script, an agent profile, a schedule — goes on starting agents on the old entry, and stops working once it is removed. Point it at `claude-tty/<model>` instead.
- **The idle timeout carries over.** On its first start the plugin copies a timeout chosen in the old panel into the settings Paseo stores for it, unless a value has already been saved there, and deletes the old file under `${XDG_CACHE_HOME:-~/.cache}/paseo-plugins/claude-tty/`.

## Settings

Under **Settings → Plugins → Claude TTY** on the selected host, or from the Command Center as "Claude TTY: settings". Paseo owns the store, so the value survives a reload, an update and a daemon restart, every client sees a change without reloading, and it is deleted with the plugin.

The **Suspend idle Claude** setting controls how long a native Claude process remains alive after the session last did anything. It defaults to one hour, and you can choose 15 minutes through 8 hours, or **Never**. It applies to every session on the host. The adapter's per-session ACP configuration carries the model, the effort level and Auto Accept, and moving the timeout in beside them would also move the value out of the store Paseo owns, so the one that survives a reload and an update stays host-wide.

Suspending stops the PTY and any background tasks it owns, but does not close or archive the Paseo agent. The adapter keeps the persisted session mapping, and the next prompt automatically launches `claude --resume` with the same Claude session, model, mode, and effort level. The timer runs from the last thing the session actually did, not from the last prompt: a turn Claude runs on its own after a task notification, the agents it launches, and the hooks it calls all count, so a session working unattended is not stopped mid-run.

A session waiting on a subagent is not suspended at all. The adapter holds the turn open until every agent it launched has reported, which is also what makes Paseo show the session as busy while they work, and a suspension stands aside for an active turn and tries again later. A turn whose agents have written nothing for fifteen minutes stops waiting, so a stuck agent cannot keep a session alive indefinitely. A command Claude runs in the background holds the turn the same way, because Claude goes idle while it runs and is woken by its report; a command that has not reported after thirty minutes — a server, typically, which never will — stops being waited on.

The plugin hands the adapter the path of the document Paseo writes, and the adapter reads it each time it schedules a suspension, so a change applies to sessions that are already open rather than only to the next adapter launch. A suspension also stands aside while a permission or question card is still waiting for an answer, and tries again later.

Setting `CLAUDE_TTY_ACP_IDLE_TIMEOUT_MS` on the daemon overrides this setting for the hosts that do it, because the adapter inherits the daemon's environment and lets the variable win; the settings screen says so when something has set it.

### Permission prompts

Every agent has an **Auto Accept** toggle, the same switch Paseo shows for its own ACP providers. While it is on, Claude Code's permission prompts are approved once without a card, including the ones it keeps even in Bypass Permissions mode, such as removing everything in the working directory. Questions Claude asks and plans it proposes still wait for an answer. Paseo's own toggle carries a shield icon, but a plugin provider has no field for one, so this one shows with the generic settings icon.

**Auto-accept in new sessions** is where the toggle starts, and is off unless you turn it on. **In Bypass Permissions sessions** overrides it for sessions in that mode, or is the same as other sessions. These exist for agents nobody is watching: `paseo run` and anything built on it can pick a mode but not a toggle, so an overnight agent started in Bypass Permissions gets auto-accept only from this setting.

An agent whose toggle you switch keeps that value, across suspensions and restarts, and stops following these settings. Every other agent reads them again at each permission prompt and whenever its mode changes, so a change here applies to open sessions too.

## Troubleshooting

**Diagnostics** runs the adapter's own host checks — Claude on the daemon's `PATH` above all. Paseo drops the adapter's stderr, so running them is the only way to read them; what Paseo itself makes of the provider is in the provider list and in `paseo plugin logs claude-tty`.

**Sessions** lists the adapter's saved sessions and the locks over them, each named after the Paseo agent holding it and saying when it was last prompted. That reads "last prompted" rather than "active" on purpose: the adapter stamps the time as a prompt starts, so a session an hour into one turn is still working. **Open** reveals the agent holding a session, and is there for as long as Paseo still lists one.

**Stop** ends the adapter process holding an open session, which closes its Claude terminal. Nothing durable goes with it: the session file, the transcript, and the Paseo agent all survive, and the next prompt resumes the same Claude session.

A PID outlives the process that earned it, so a stop first establishes that the process really is the one that took the lock — the right kind of process, and one that cannot have started after the lock it holds. Anything else is refused, named, and left running, including a process that has already exited and is waiting to be reaped. The adapter is given ten seconds to close the session itself before it is forced.

A lock names the process holding a session; the adapter clears its own on exit and recovers one left by a dead process, so **Release lock** is only for a lock that outlived its process and is still in the way — including one left behind by a stop that had to force the process. Releasing is refused while the recorded process is alive. A session file that cannot be read can be moved aside rather than deleted, so the failure is still there to diagnose.

The adapter's [troubleshooting table](../../apps/claude-tty-acp/README.md#troubleshooting) covers everything that goes wrong once a session is running. Its log is kept at `${XDG_STATE_HOME:-~/.local/state}/claude-tty-acp/logs/claude-tty-acp.log`, or under `CLAUDE_TTY_ACP_STATE_DIR` where that is set, because the daemon reads the adapter's stderr and keeps none of it.

The provider goes away with the plugin, so removing it is `paseo plugin remove claude-tty`. What that leaves behind is the state directory, and the **Danger zone** deletes it: saved sessions stop resuming, it is refused while a session is open, and Claude's own configuration and transcripts are never touched.

## Development

```sh
paseo plugin reload claude-tty
paseo plugin logs claude-tty
```

```sh
pnpm --filter @paseo-plugins/claude-tty typecheck
pnpm --filter @paseo-plugins/claude-tty test
```

See [CLAUDE.md](./CLAUDE.md) for the constraints that are not obvious from the code.
