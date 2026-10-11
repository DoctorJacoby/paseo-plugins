# Claude TTY

Adds **Claude TTY** to Paseo's providers: the real interactive Claude Code CLI, run in a terminal by the [Claude TTY ACP adapter](../../apps/claude-tty-acp).
A sidebar panel diagnoses the adapter and manages its saved sessions on the selected host.

## Installation

Requires:

- Paseo 0.11 or newer
- `pnpm` on the daemon's `PATH`
- Claude Code, installed and logged in as the user the daemon runs as

```sh
paseo plugin add github:sleeyax/paseo-plugins:plugins/claude-tty
```

Update with `paseo plugin update claude-tty`.
To install from source, see the [root README](../../README.md#from-source).

Install the plugin on each host that should offer Claude.

If the daemon can't build the adapter, build it from a clone yourself and put the path to `apps/claude-tty-acp/bin/claude-tty-acp` in the **Adapter executable** setting.
The panel's **Adapter** section shows which adapter runs and whether it can.

## Usage

### Start a session

Pick **Claude TTY** as the provider when you create an agent.
Model, mode and effort pickers work as described in the [adapter's README](../../apps/claude-tty-acp/README.md).
A message you send while Claude is working interrupts the turn and starts a new one with your message.

### Answer questions and plans

When Claude asks you something, all its questions arrive in one form.
Pick an option, tick several where Claude allows it, or type your own answer.
A plan arrives as a card with **Implement** and **Reject**.

You can answer a question form from a terminal too, keyed by the header each question shows:

```sh
paseo permit allow <agent> <id> --input '{"answers":{"Runtime":"Node"}}'
```

### Follow subagents and background commands

Each subagent a session launches opens as a subsession under its agent.
The subsession shows the subagent's instructions, its replies and every tool call it makes.
A command Claude runs in the background gets a subsession with its output so far.
Subsessions are read-only, and close when the subagent or command finishes.
A subagent launched by another subagent has no subsession; its steps stay on its parent's card.

### Check the host and manage sessions

Open **Claude TTY** from the sidebar.

- **Diagnostics** → **Run** checks the host the adapter runs on, such as whether Claude is on the daemon's `PATH`.
- **Sessions** lists the saved sessions, named after the agent holding each one.
  **Open** jumps to that agent, **Stop** closes its Claude terminal, and **Release lock** clears a lock its process left behind.
  A stopped session resumes on its next prompt.
- **Danger zone** deletes every saved session.
  `paseo plugin remove claude-tty` leaves them on disk; this is how you remove them.

## Settings

Open **Settings → Plugins → Claude TTY**, or run **Claude TTY: settings** from the Command Center.
Each host has its own settings.

| Setting | Default | What it does |
| --- | --- | --- |
| Adapter executable | empty | Path to a built adapter to run instead of the one in the plugin's checkout. Sessions already open keep the adapter they started on. |
| Suspend idle Claude | 1 hour | How long Claude keeps running after a session goes quiet: 15 minutes to 8 hours, or Never. The next prompt resumes the same conversation. |
| Auto-accept in new sessions | off | Where each agent's **Auto Accept** toggle starts. |
| In Bypass Permissions sessions | Same as other sessions | Overrides the switch above for sessions in Bypass Permissions mode. |

**Auto Accept** approves Claude Code's permission prompts without a card.
Questions and plans still wait for you.
An agent whose toggle you switch keeps its own value; every other agent follows these settings, including open ones.
Agents started with `paseo run` can pick a mode but not the toggle, so use **In Bypass Permissions sessions** to auto-accept for unattended agents.

## Troubleshooting

Paseo discards the adapter's error output.
When the provider is unavailable or a session won't start, run **Diagnostics** on the panel first.

A systemd daemon's `PATH` usually lacks `claude`.
Set `CLAUDE_BIN` in the daemon's environment to Claude's absolute path, or add its directory to the daemon's `PATH`.

The adapter logs to `${XDG_STATE_HOME:-~/.local/state}/claude-tty-acp/logs/claude-tty-acp.log`, or under `CLAUDE_TTY_ACP_STATE_DIR` when that is set.
For errors inside a running session, see the [adapter's troubleshooting](../../apps/claude-tty-acp/README.md#troubleshooting).

## Development

For development instructions, see the [root README](../../README.md#development).

After changing the adapter, rebuild it with `pnpm --filter @paseo-plugins/claude-tty-acp build`.
Sessions already running keep the old build.

### A second copy to develop against

Reloading the plugin stops Claude in every session on its provider.
To keep your working sessions alive, install a second copy under its own ID and reload only that one.

In a second checkout, such as a `git worktree` of this one:

```sh
pnpm --filter @paseo-plugins/claude-tty identity claude-tty-dev
pnpm install --frozen-lockfile
pnpm --filter @paseo-plugins/claude-tty-acp build
paseo plugin add "/absolute/path/to/the/second/checkout/plugins/claude-tty"
```

The copy shows up as **Claude TTY (dev)**, with its own provider and its own state under `~/.local/state/claude-tty-dev-acp/`.
Agents can't move between the two providers, so start throwaway sessions on the dev one.
`pnpm --filter @paseo-plugins/claude-tty identity claude-tty` stamps the checkout back.

Design decisions are in [docs/adr](docs/adr).
