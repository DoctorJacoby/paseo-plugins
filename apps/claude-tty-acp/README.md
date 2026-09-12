# Claude TTY ACP

Run the genuine interactive Claude Code CLI as a native Paseo agent.

Paseo speaks [ACP](https://agentclientprotocol.com) to this adapter, and the adapter keeps a single real `claude` process in a PTY per session.
It translates that process's transcripts and hooks into native Paseo messages, reasoning, tool calls, plans, permissions, models, modes, effort levels, slash commands, attachments, cancellation, and history.
There is no `claude -p` and no Claude Agent SDK anywhere in the path.

## Why?

Paseo's built-in Claude agent runs on the Claude Agent SDK.
Agent SDK integrations appear to consume usage limits faster than the Claude Code CLI or its editor extensions, [as reported for t3code and similar tools](https://github.com/pingdotgg/t3code/issues/7338#issuecomment-5426425282); whether the cause is the SDK, its integrations, or Anthropic's backend is unclear.

This adapter avoids the SDK by driving the same CLI you would otherwise run in a terminal.
You keep its binary, authentication, billing, sessions, `CLAUDE.md` hierarchy, MCP servers, plugins, skills, and permission rules, and get Paseo's native agent UI on top of them.
The price is that every native affordance has to be reconstructed from terminal output, transcript files, and hooks, which is where the [limitations](#limitations) come from.

## Requirements

- Linux or macOS
- Node.js 22 or newer
- pnpm
- A current Claude Code CLI, authenticated on the same host as the Paseo daemon
- Paseo 0.8 or newer

## Installation

The adapter is installed through the [Claude TTY plugin](../../plugins/claude-tty): `paseo plugin add sleeyax/paseo-plugins --path plugins/claude-tty` clones this repository, builds the adapter, and registers it as the `claude-tty` provider.
The plugin's README covers installing, updating and removing it, and upgrading a host that registered this adapter in its Paseo configuration by hand.

Setup is host-local: the adapter runs wherever the Paseo daemon runs, so install the plugin on each host that should offer Claude.
See [Multiple hosts](#multiple-hosts) for what that means in practice.

### Authenticate Claude

Run `claude` interactively as the same OS user that runs the Paseo daemon, and complete authentication before using the provider.
If the daemon runs through systemd, SSH into that account or use an equivalent login shell so Claude writes its credentials into the correct home directory.

### Multiple hosts

Hosts share nothing: no processes, ports, locks, state, credentials, paths, or sessions.
Selecting a VPS in a client makes that VPS's daemon launch its own adapter and Claude process, read the VPS's Claude configuration and transcripts, and stream ACP back to the client.
The same provider ID is therefore safe to use everywhere.

## Environment

The adapter inherits the Paseo daemon's environment.

| Variable | Purpose |
| --- | --- |
| `CLAUDE_BIN` | Absolute path to Claude when the daemon's `PATH` cannot find `claude`. |
| `CLAUDE_CONFIG_DIR` | Existing Claude configuration, credentials, plugins, commands, skills, and transcript root. |
| `CLAUDE_TTY_ACP_STATE_DIR` | Adapter session mappings and locks; defaults to the host's XDG state directory. |
| `CLAUDE_TTY_HOST_SESSION` | `1` runs this agent's session beside the adapter even where the host would otherwise put it in a container. See [Sessions in a container](#sessions-in-a-container). |
| `TOOLCHAIN_BOX_BIN` | The `toolchain-box` the adapter asks where a session runs; defaults to `~/.local/bin/toolchain-box`, and where there is none every session runs beside the adapter. |
| `CLAUDE_TTY_ACP_IDLE_TIMEOUT_MS` | Stop an idle session's native Claude process after this many milliseconds. Overrides the Claude TTY plugin's saved setting; without either, the default is `3600000` (one hour). Set to `0` to disable suspension. A value that is not a whole number of milliseconds in range is logged and ignored rather than fatal. |
| `XDG_STATE_HOME` | Base for adapter state when `CLAUDE_TTY_ACP_STATE_DIR` is unset. |

For a systemd service, set `CLAUDE_BIN` to the output of `command -v claude` in the daemon user's login shell rather than relying on a shell-specific `PATH`.

## Sessions

Paseo session IDs stay stable even though Claude's own session ID can rotate after `/clear`.
The mapping is persisted only after the first real prompt, so provider probes leave no saved sessions behind.
Loading a session replays its transcript and launches `claude --resume` lazily on the next prompt.

Each active session owns an isolated PTY, hook route, transcript reader, permission bridge, lock, and attachment directory.
Sessions run concurrently, work inside a single session stays serialized, and a second adapter process cannot open a session that is already active on the host.
Locks left behind by dead processes are recovered automatically.

Once a session has been quiet for an hour, by default, the adapter stops its native Claude process.
When that timeout expires it sends Ctrl-D, kills the PTY if it does not exit promptly, and thereby stops any background tasks still owned by that Claude process.
The logical ACP session, transcript mapping, selected model and mode, and session lock remain intact.
The next prompt launches `claude --resume <id>` automatically, so the conversation continues without keeping its process alive indefinitely.
Quiet is observed rather than inferred from prompts: the clock runs from the last thing the session actually did, whether that was the end of a prompt, a hook Claude called, a record it wrote, a turn it was woken for by a task notification, or a step one of its background agents took.
A prompt is only what Paseo asked for; Claude goes on working after one — answering for an agent that reported, launching the next — and a suspension measured from the prompt alone stopped exactly that work an hour into it, mid-run.

The timeout is read at each suspension rather than once at startup: `CLAUDE_TTY_ACP_IDLE_TIMEOUT_MS` if it is set, otherwise `values.idleTimeoutMs` in the JSON document named by `--settings-file`, which is where Paseo stores the Claude TTY plugin's settings and which that plugin passes when it spawns the adapter.
Reading it per suspension is what lets a change on that settings screen reach a session that is already connected, and it is also why an unreadable document or a malformed variable leaves the session running rather than taking the adapter down.
An adapter started without `--settings-file` — by hand, or by anything that is not that plugin — has the variable and the default and nothing else.

A suspension waits for its session to be genuinely idle. It stands aside while a turn is running and while a permission or question card is still waiting for an answer — stopping Claude then would cancel the request behind that card and leave it on screen in Paseo answering to nothing — and a suspension that fails re-arms rather than giving up, because giving up once would keep that process alive for the rest of its life.

## Models, modes and effort

The model selector offers Claude Code's rolling aliases — `inherit`, `opus`, `fable`, `sonnet`, `haiku` — plus the full catalog that Paseo's native Claude provider exposes, including explicit releases and 1M-context variants.
Claude Code has no supported way to list models without opening an interactive session, so that catalog is versioned with the adapter while the aliases keep following Claude's.

The mode selector offers Default, Accept Edits, Plan, Auto, and Bypass Permissions.

The effort selector offers Claude Code's own `--effort` levels — Low, Medium, High, Extra high and Max — ahead of a Default that passes no flag and leaves Claude at whatever its settings name.
Paseo shows it as the session's thinking level.

Bypass Permissions is last and named for what it does: nothing stops a command before it runs, which is why it is a mode a person picks per session rather than a default.
Claude gates it behind a disclaimer it keeps once per host, so the first session that asks for the mode raises a card in Paseo carrying the same warning; accepting it answers Claude's dialog, declining it fails the session start rather than quietly running in another mode.
Because Claude remembers the answer, the card appears once on a host and never again — including for the scheduled, unattended sessions the mode exists for.

Changing any of the three before launch changes startup flags.
Changing one while idle restarts and resumes Claude with deterministic flags, and changing one during a turn is rejected.

All three are published twice, because the two ACP bridges Paseo can run this adapter on read different fields.
`session/new` answers with the older `models` and `modes` state *and* with `configOptions` carrying a `model` selector and a `thought_level` one, and the adapter serves both `session/set_model` and `session/set_config_option`.
The daemon's own bridge prefers `models` and takes the effort levels only from the config options; the bridge a Paseo plugin provider runs on reads `configOptions` and nothing else, and would show an empty model picker without them.

### Auto Accept

`configOptions` also carries `auto_accept`, a boolean the plugin provider's bridge shows as a toggle on the agent, with the ID Paseo gives its own ACP providers' toggle.
While it is on, a `PermissionRequest` is answered with Allow once instead of a card, and none of Claude's permission suggestions are applied, so switching it off again leaves no rule behind.
That covers the prompts Claude Code keeps even in Bypass Permissions mode, such as a removal of the working directory's contents; `AskUserQuestion` and `ExitPlanMode` are for a person and still raise their cards.

A session nobody has switched follows the plugin's settings for its current mode: `values.bypassAutoAccept` (`on` or `off`) for a Bypass Permissions session, and otherwise `values.autoAccept`, both in the document named by `--settings-file`.
They are read again at every request and whenever the mode changes, and the session publishes a `config_option_update` when the answer moves, so the toggle shows what the next request gets.
Without a readable document the answer is off.
Switching the toggle is taken even mid-turn, restarts nothing, and is saved with the session, after which the settings no longer apply to it.

## Prompt content

Images and embedded resources become mode-0600 host-local files for the duration of a turn.
Host-local file links become `@path` references.
Audio and remote resource links are rejected with an explicit error.

## How it works

```text
Paseo ──ACP over stdio──► claude-tty-acp ──keystrokes over a PTY──► claude
                               ▲    ▲
        hooks over loopback HTTP┘    └transcript JSONL, polled
```

The plugin starts one adapter process per ACP session, and that process speaks ACP as newline-delimited JSON on stdout while its structured logs go to stderr — and, because the daemon reads stderr and keeps none of it, to `logs/claude-tty-acp.log` under the state directory as well, where every process on the host appends with its pid and a full file is moved aside once.
The session owns its own `claude` process in a PTY.

A session starts empty: `session/new` returns an ID immediately and launches nothing, so a provider probe or an untouched draft never spawns Claude.
The first prompt launches `claude --session-id <id>` and later launches reuse `claude --resume <id>`, with the model, mode and effort selectors translated into `--model`, `--permission-mode` and `--effort`.

Every launch gets a private runtime directory holding a generated `settings.json` and hook client, passed with `--settings`, so the adapter registers its hooks and its status line without touching the user's Claude configuration.
No global hooks are required; remove any legacy hooks left in `~/.claude/settings.json` after uninstalling the old panel plugin.
Startup is complete once the `SessionStart` hook has arrived and Claude's interactive prompt appears on a headless xterm screen that mirrors the PTY; that screen is used only for readiness, dialog detection, confirming a prompt left the input box, and the terminal snapshot in startup errors.
If Claude stops first at its workspace-trust screen, the adapter surfaces the exact cwd as an ACP permission card in Paseo.
Approving the card selects **Yes, I trust this folder** in the PTY and gives Claude a fresh startup window; denying or cancelling it fails closed without changing Claude's trust state.

Readiness also requires the screen to have stopped changing, and that is not a nicety.
A resumed session paints its entire conversation before its input box exists, and text inside that conversation can satisfy every readiness signal on its own — a footer quoted in a message, a token count, the words `auto mode on`.
A prompt pasted into that window is dropped, and because the paste never echoes there is nothing for the submit loop to notice: the adapter presses Enter once into whatever has focus and the turn then waits for a `Stop` hook that is never coming.

The second thing a resume can stop at is Claude asking how to open a long or old conversation — **Resume from summary**, **Resume full session as-is**, **Don't ask me again** — and the idle timeout guarantees every long-lived session eventually meets it.
The adapter answers it the same way it answers the trust screen, by moving the selection and pressing Enter, and it always keeps the full session: the conversation is the ACP session it was asked to restore, and a summary would silently replace the history Paseo has already replayed into its timeline.
Left unanswered this dialog is what a lost first prompt after a suspension looks like from the outside: the readiness signal came from the restored conversation behind the dialog, and the Enter that followed the paste answered the dialog instead of sending the prompt.

Slash commands are the one thing the adapter never asks Claude for: an interactive session has no way to list them, so the adapter walks the user's, the project's and every enabled plugin's command and skill directories itself and publishes the result as ACP available commands.

### Prompts go in as keystrokes

A prompt is flattened into one block of text: images and embedded resources become files in the runtime directory referenced as `@path`, and host-local resource links become `@path` directly.
The adapter writes that text into the PTY wrapped in bracketed paste, waits briefly, then writes Enter, exactly as a person pasting into the terminal would.
The paste ends with a space so Claude's completion menu is closed rather than swallowing that Enter, and the adapter watches its input box on the headless screen and presses Enter again while the prompt is still sitting there, because Claude drops the key while it is settling a paste.

Cancellation is the same kind of impersonation: an Escape keystroke, plus a short fallback that ends the turn when no `Stop` hook follows.
Changing the model, mode or effort while idle sends Ctrl-D, waits for the process to exit, and relaunches with `--resume`, which is why the change survives as a real flag rather than an in-band command.

### Output comes out of the transcript

Nothing that reaches Paseo is scraped from the terminal.
Claude appends its own JSONL transcript under its projects directory, and the adapter tails that file by byte offset every 40ms, re-reading from the start when the first bytes of the file change because Claude rewrote or replaced it.

A translator turns each record into an ACP session update — user and agent chunks, thinking, tool calls with diffs and file locations, `TodoWrite` into a plan, token usage into a context-window update — and dedupes by record key so re-reads and history replay never emit the same thing twice.
Loading a persisted session runs that translator over the whole file to rebuild the conversation, and still launches nothing until the next prompt.

Every tool-call update goes out twice: once as the ACP update, and just ahead of it as a copy on the vendor method `_claude_tty/tool_call`.
Paseo has two ACP bridges and only one of them reads a tool call whole.
Its own builds a card out of the update's `kind`, `content` blocks and `locations`; the one behind the plugin SDK's `runAcpProvider` keeps `rawInput` and `rawOutput`, renders every call as an edit or as raw JSON, and drops the rest before any hook it offers can see it.
The copy is the only way a plugin gets those fields back, and a client that has no use for it ignores it, which is what both of Paseo's bridges do with an extension they were not written for.

A message typed while Claude is working is the one thing that is not written as a turn.
Claude absorbs it mid-turn, at its next tool result, and writes a `queued_command` attachment there: no user turn ever carries the message, and it reaches the transcript nowhere else, so that attachment is the only record of it.
It is read as the message, keyed by the id the queue gave the item rather than by the record it was written in, since a queue rewritten under a new record names the same item and says nothing new.

### Subagents come out of their own transcripts

A session's transcript says only that a subagent was launched, and one launched asynchronously answers its launcher the moment it starts.
Left there, an agent that runs for ten minutes would show as a tool call that finished immediately, with everything it then did happening out of sight.

Claude writes each subagent's turns to `<projects>/<session id>/subagents/agent-<agent id>.jsonl`, and the adapter follows those files as well, five times a second, joining each to its launcher through the agent ID Claude records beside the launching tool result.
Only the end of a turn reads past that bound, for the last word; the flush a hook does before every tool call leaves it alone, because Claude is blocked on that flush and the subagents are not what it is waiting for.
An agent that has reported is dropped from the poll, so a session that runs hundreds of them is not still stat'ing the first.
Its steps — what it says, and the tools it calls — are streamed onto the launcher's tool call as a bounded tail of recent steps, which is why they never arrive as message chunks: a turn ends by counting those, and a subagent still working after its launcher has answered would hold the session's turn open for as long as it ran.
A card is rendered as plain text and has one line per step, so each is written for that: markdown is read back out of what the subagent says, a path keeps the tail that says which file it is, and a tool call is named by what it was for rather than by whichever argument came first.
A nested subagent's steps join the card of the agent that launched it, marked as its own.

That tool call stays in progress until Claude reports the agent has stopped, which it does by writing a `<task-notification>` — the only record of it, and one that is otherwise scrubbed out of the text before it is shown.
Where that notification is written depends on what the session was doing when the agent finished: an idle session is woken with it as a user turn of its own, and one that is mid-turn has it queued instead, left behind only as a `queued_command` attachment.
Both are read, since reading the turn alone loses every agent that finished while Claude was working, and the same notification is written many times over — queued, delivered, and rewritten at every turn boundary the queue survives — so it is read as news only while the card it names is still open.
Anything but a clean finish leaves the call failed.
An agent Claude stops itself, with `TaskStop`, is closed on that stop instead: a stopped agent writes no report and sends no notification, so nothing else would ever close its card, and it would go on being counted as running until the bound below gave up on it.

The session's turn is held open for as long as any of those agents is still running.
Paseo reads a session as busy from the turn it has open and from nothing else — an ACP agent has no other way to say so — and Claude goes idle the moment it launches a background agent, so without this a session with ten minutes of work ahead of it reads as ready, and the answer Claude writes when the agent reports arrives outside any turn at all.
The hold ends at the first `Stop` hook with nothing left running, which is the end of the turn Claude runs to react to the notification, so the reply about the agent lands inside the turn that launched it.
A turn that has been waiting on agents that have written nothing for fifteen minutes gives up and ends, because a session that is busy is also a session that is never suspended, and an agent that never reports would hold one open for the rest of its life.
Those fifteen minutes are measured from the agents alone: an agent that is still running shows it by writing, and nothing Claude does says whether it is.
Giving up is the end of it: those agents stop being counted, so the next turn does not hold for a poll interval and give up on them all over again.
Whichever bound has run out, the turn does not end while Claude is still writing: a report wakes Claude for the answer that belongs inside the turn, and that answer is given five minutes of its own, measured against anything Claude writes.
Five rather than one because Claude writes a response to its transcript only once the whole of it has streamed: a sentence followed by the long prompt of the next agent it dispatches shows nothing for as long as that prompt takes to generate, and a minute was not enough to cover one.
Cancelling is unaffected: a held turn ends as promptly as any other, which is what keeps Paseo's replacement of a prompt sent mid-turn inside its two-second budget.

A command Claude runs in the background holds the turn open the same way, for the same reason.
It is dispatched exactly as an asynchronous agent is — the tool answers with the id of a task still running, Claude goes idle, and it is woken by a `<task-notification>` when the command ends — so a turn that ends at the `Stop` in between leaves everything Claude does from the report onwards outside any turn, which is a session that reads as ready while it works.
Claude records the id its report will name in `backgroundTaskId` beside the launching tool result, and the notification carries it as the `<task-id>`, so the two are joined the way an agent's launch and report are.
The command has no card of its own: its tool call is the launch, which finished, and everything it does goes to a file the adapter does not follow.
A `TaskStop` naming its id ends the wait for it as it ends an agent's, since a stop names either through the one `task_id`.
That is also why its bound is a flat thirty minutes from the moment the turn was held rather than a silence: a running command shows nothing to measure a silence against, and the bound starts again whenever a command is launched or reports.
Thirty because backgrounding is what Claude does with a command precisely when it takes a while: on the sessions this was measured on the median command took four minutes and the longest genuine wait was a twenty-one minute code review, while the ones that ran for hours were servers and poll loops, which never report at all and are what the bound is there to let go of.
Each kind of work is bounded on its own and the turn ends only once every one of them has run out, so a command's thirty minutes are not cut short by the agents beside it having gone quiet first.

### An adapter does not outlive its workspace

The daemon closes the connection when it archives or deletes an agent — archiving a workspace archives each of its agents first — and that is what normally stops this process.
An adapter that close never reached has nothing left to end it, and a directory that is no longer there is the visible symptom: Paseo archives a workspace by deleting its directory, and an adapter left standing in one that has gone can do nothing for anyone — Claude cannot be started there — so it holds its memory until the machine is rebooted.
The adapter therefore checks the directory of every session it holds once a minute, and stops once all of them are missing at the same time, each having been missing twice running: twice rather than once so a workspace replaced at the same path, which is what reusing one looks like on disk, is not read as the end of the session.
Every directory is watched for as long as its session lives, so one that comes back counts as there again and keeps the adapter standing.
A directory that cannot be read for any other reason is still there, and no session is stopped over a failure to look.

### Sessions in a container

A host may decide that a session's working directory belongs in a container rather than beside the adapter.
The adapter does not decide this and does not look: it runs `toolchain-box session <cwd>` and obeys the answer, because a working directory is something a container can write and a session that could talk its way onto the host would defeat the arrangement.
A host with no such tool runs every session beside the adapter, which is what the adapter did before any of this.

The answer is one of three.
**Box** names the container, the `~/.claude` it writes into as the host sees it, and where the container mounts that; the adapter starts the box and then spawns `claude` through `toolchain-box exec`, which is a `podman exec` into it.
The session is still the interactive TUI under a pty — `podman exec -t` carries the adapter's pty in — and a box that will not start fails the session rather than falling back to the host.
**Host** runs it here.
**Refuse** fails `session/new` with the host's reason, and `CLAUDE_TTY_HOST_SESSION=1` is the way to take the host for one agent anyway; Paseo's `paseo run --env` puts it in the agent's environment.

Two things follow from the container not sharing this host's filesystem or its loopback:

- Everything Claude reads at launch — its settings, the hook client, the status-line file, prompt attachments — goes in a runtime directory inside that mounted `~/.claude` rather than in this host's temporary directory, and every path written into the settings is the path the container sees. The adapter goes on reading its own side of the same files, and a transcript Claude reports at its own path is read back at the host's.
- The hook server's loopback port is unreachable from the container, so a boxed session gets a second listener on a unix socket in that same runtime directory. It carries the same per-session route and is trusted no further than the port is.

`podman exec` proxies no signals, so nothing about killing a session would reach the process inside the box.
That is why the spawn goes through `toolchain-box exec` rather than a podman command line of the adapter's own: it leaves behind the watchdog that stops the process tree in the box once the client is gone, and a second copy of that mechanism here is the last thing worth having.

### Hooks carry everything interactive

The adapter runs a single loopback HTTP server whose URL carries a per-process secret and a per-session route, and the generated hook client posts each hook payload to it and hands the JSON answer back to Claude.

`Stop`, `StopFailure` and `SessionEnd` end the turn with `end_turn`, `refusal` and `cancelled`, each first flushing the transcript until the file stops growing so the updates land before the turn does.

`PermissionRequest` becomes an ACP permission request offering Allow once, Claude's own permission suggestions as always-allow options, and Deny, and the answer becomes the hook's decision — unless [Auto Accept](#auto-accept) is on, which answers Allow once without asking.
`PreToolUse` intercepts two tools before they run: `AskUserQuestion` renders as one permission card for the whole call, and `ExitPlanMode` renders as a plan approval.

### State on disk

The state directory holds one JSON file per session, mapping the Paseo session ID to Claude's own session ID, cwd, model, mode and effort, plus a lock file naming the process that has the session open.
A file written before the effort selector existed names none, which reads as the default effort.
Runtime directories live in the host's temporary directory — or, for a session in a container, in the `~/.claude` that container mounts — record their owner PID, and are swept on the next adapter startup if that process is gone.

## Limitations

Claude keeps its own MCP servers, plugins, skills, permissions, and `CLAUDE.md` hierarchy, but MCP servers injected by Paseo over ACP are rejected, because a running interactive Claude process cannot adopt them.
Claude's own MCP servers are unaffected; it loads them from its usual configuration at startup.

### Slash commands arrive after the session does

Paseo learns this adapter's slash commands, and with them Claude's skills, from an ACP `available_commands_update` notification.
The adapter sends it as soon as `session/new` returns, because Paseo drops any session update carrying a session ID it has not received yet.

A draft agent's composer lists commands for an agent that does not exist yet: Paseo spawns a throwaway session, reads the commands back, and closes it, and it waits for that first batch only when the provider asks it to.
The plugin asks, through `acpOptions.waitForInitialCommands`, for up to 10 seconds; without the wait the composer stays empty until the agent has taken its first turn, after which the live session has the commands cached.

Related, a draft must carry a model ID that is not literally `default`: Paseo reads `default` as "no model selected" and returns an empty list before the adapter ever launches, which is why the pass-through entry is named `inherit` instead.

### A question card needs the plugin to be worth answering

Claude's `AskUserQuestion` raises one permission card for the whole tool call, carrying every question it asks.
Under the Claude TTY plugin that card is Paseo's own question form — radio buttons, checkboxes for a multi-select question, a box for an answer that is on none of the lists — and every answer comes back in one response, because the plugin republishes the request and hands the answers back down here.
See the plugin's own notes for how, and for what it costs: an option's `preview` has no surface in that form and is folded into its description.

The adapter alone cannot do any of that.
ACP has one shape for asking permission — a list of options, one of them chosen — so an adapter run outside the plugin, or without the `--answers-dir` it is passed at spawn, offers one option per answer while a single question is on the card and *Answer in chat* otherwise.
Whatever the card is left with unanswered is denied back to Claude with instructions to restate those questions in prose and wait for a normal message, which is also what a cancelled or dismissed card does.

### Prompts sent mid-turn interrupt the turn

Paseo cannot steer a running turn on an external provider: an ACP session offers `session/prompt` and `session/cancel` and nothing that injects text into a turn that is already in flight.
Sending a prompt while Claude is working therefore takes Paseo's replace path, which cancels the active turn, waits for the pending `session/prompt` to answer, and starts the new turn once it does.

The adapter cancels the way a person would, by sending Escape into the PTY, and ends the turn as soon as Claude's `Stop` hook confirms the interrupt or, when no hook follows, after a short fallback.
Both settle inside the 2 second budget Paseo allows before it gives up and fails the replacement with `A foreground turn is already active`.

So a mid-turn prompt discards whatever Claude was doing rather than queueing behind it the way typing into the Claude CLI does, and Claude sees the interruption in its own transcript.
If Escape has not taken effect by the time the fallback fires, Claude also queues the replacement itself and answers it after the interrupted work unwinds.
Real steering would need Paseo's generic ACP provider to offer external providers an entrypoint for it.

### Auto mode can hang on the denial limit

Auto mode decides permissions with a classifier, and after 3 consecutive or 20 total classifier denials Claude Code stops deciding and asks the person at the keyboard instead.
That escalation deliberately bypasses every remote channel — the `PermissionRequest` hook, Claude's bridge, and its channel callbacks — so the adapter is never consulted and Paseo shows no permission card.
Claude then waits at a dialog inside its PTY and no `Stop` hook follows, so the turn never finishes: the first escalation in a session denies itself after 2 minutes, and every later one waits indefinitely.

Cancel the turn from Paseo to recover, which sends Escape into the PTY and dismisses the dialog; sending a new prompt does the same, because Paseo cancels before it replaces the turn.
Default mode avoids the limit entirely, because there every decision reaches the adapter through the `PermissionRequest` hook.
Claude does report the wait over its `Notification` hook, which the adapter does not register yet, so a future release can surface the dialog or end the turn with an explicit error instead of hanging.

### The token usage meter stays empty, so the reading goes in the conversation

Paseo's token usage meter renders only once it knows both a context window size and the tokens currently in it, and it fills those in for its own providers alone.
ACP carries the pair as a `usage_update` session notification, which Paseo's generic ACP provider validates and then discards, so nothing an external provider reports can reach the meter.

The adapter reports a `Context: 137.4k tokens (69%)` line at the end of a turn instead, and stays silent until Claude has reported one.

Both numbers are Claude's own, because neither can be reconstructed.
The transcript records per-message `usage` counts but nothing about the window holding them: no record type in it carries a context window at all, and its `message.model` drops the `[1m]` marker that separates a 200k session from a 1M one, so a model ID read from there implies nothing.
Nor is the size a table the adapter could keep, because Claude resolves it per session from `CLAUDE_CODE_MAX_CONTEXT_TOKENS`, a `native_1m` flag in its model catalog, the deployment behind the model, a 1M beta header and a clamp back to 200k.
Hooks do not carry it either; their shared payload stops at `session_id`, `transcript_path`, `cwd`, `prompt_id`, `permission_mode`, `agent_id`, `agent_type` and `effort`.

The status line is where Claude does report it, so the generated `settings.json` registers one.
Claude runs a status line command through a shell and renders its stdout, so the command is `cat > <runtime directory>/context.json`: one `cat`, and no output to land on the terminal screen.
It runs when the reading changes rather than on a timer, which is at least once per assistant response: usage moves on every tool result too, so a tool-heavy turn costs several `cat`s rather than one.

Registering one is not free of the screen, though: Claude drops most of its footer hints once a status line exists, `? for shortcuts` among them, and that was the first signal `isReadyScreen` looked for.
Readiness now rests on the mode indicator, which Claude shows in every mode and writes as `manual mode on` in the default one, because the token badge is absent until a session has context and the bare prompt marker does not match while the input box still holds its placeholder.

Claude renders that line *after* the `Stop` hook, measured at about 320ms, so reading the file when the turn ends yields the turn before it.
The adapter notes the file's mtime as the hook arrives and then waits, for up to a second, for a rewrite that moves it, staying silent when none does.
The mtime is taken at the hook rather than at the read because draining the transcript and delivering the turn's last message both run in between and can outlast Claude's refresh, and it is compared against itself rather than against `Date.now()` because Linux stamps files from a coarse clock that can date a write milliseconds before the wall clock that observed it.
The timestamp rather than the contents is what marks a reading as this turn's, because two turns that land on the same numbers write identical files.
Claude truncates the file before each rewrite, so a torn read is waited out rather than reported, and a cancelled turn skips the wait entirely because Paseo allows only 2s for the prompt it is replacing to answer.

That wait is what the turn's own completion is held on, so a session that never reports would otherwise pay it forever: after three turns without a reading it stops waiting and only looks, which costs a `stat`, and says so once in the log.
Looking alone cannot find a reading written after the Stop hook, which is the whole reason the wait exists, so one turn in four keeps waiting properly and a session that starts reporting again is picked up rather than written off.
A wait a stop ended counts towards none of this, because a cancelled wait says nothing about whether Claude reports at all.

The line is a turn-boundary sample rather than a live meter, and it is not part of the session's history: the adapter generates it, so it never enters Claude's transcript and a reloaded session replays without any of the readings it showed while you worked.
The session title is not an alternative either: Paseo keeps an ACP `session_info_update` title in `runtimeInfo().extra`, which its own clients never read and which does not emit state when it changes.
Filling the real meter needs Paseo's generic ACP provider to honour `usage_update` the way its direct providers do, mapping it onto the `contextWindowMaxTokens` and `contextWindowUsedTokens` its `AgentUsage` already carries.

## Troubleshooting

| Symptom | Action |
| --- | --- |
| `Could not start claude` | Set `CLAUDE_BIN` to an absolute executable path visible to the daemon. |
| Workspace trust permission appears | Approve only when the displayed folder is a project you created or trust; Claude remembers the choice. |
| Bypass Permissions disclaimer card appears | Claude has not been told this host accepts the mode. Accept it to start the session, or pick another mode; the answer is remembered for the host. |
| SessionStart handshake timeout | If no workspace trust or Bypass Permissions card appeared, check Claude organization hook policy, inherited settings, loopback access, and the terminal snapshot in the adapter log. |
| Claude opens a login screen | Authenticate as the Paseo daemon user and verify `HOME` or `CLAUDE_CONFIG_DIR`. |
| Persisted session not found | Select the host that created it and verify `CLAUDE_TTY_ACP_STATE_DIR`. |
| Session belongs to another cwd | Load it with its original absolute project path. |
| Session already active | Close the other native agent connection; remove a lock only after verifying its recorded PID is dead. |
| `A foreground turn is already active` | The interrupted turn had not settled when Paseo started its replacement; send the prompt again. |
| Turn never finishes in Auto mode | Claude is waiting at a keyboard-only dialog after the classifier denial limit; cancel the turn and prefer Default mode. |
| PTY exits unexpectedly | Inspect the adapter log and run Claude interactively in the same cwd and environment. |
| Corrupt transcript or state | Preserve the file for diagnosis, then move only the named session JSON or transcript aside before retrying. |
| Commands or plugins missing | Verify the daemon sees the expected `CLAUDE_CONFIG_DIR`, project `.claude` files, and enabled plugin settings. |

## Development

The executable writes ACP only to stdout and sends structured diagnostics to stderr, which the daemon reads and drops, so the place to look when something misbehaves is the copy it keeps: `${XDG_STATE_HOME:-~/.local/state}/claude-tty-acp/logs/claude-tty-acp.log` (or under `CLAUDE_TTY_ACP_STATE_DIR`), one line of JSON per record, with the pid of the adapter process that wrote it.

Check a host without starting ACP:

```sh
pnpm --filter @paseo-plugins/claude-tty-acp diagnose
```

`--json` prints the same checks as one machine-readable line instead of the report, for a caller that wants to act on them rather than read them:

```sh
apps/claude-tty-acp/bin/claude-tty-acp --diagnose --json
```

The line is `{ "version", "ok", "checks": [{ "id", "label", "ok", "detail" }] }`, the check IDs are `node`, `claude`, `config` and `state`, and the exit code is 1 when any check fails, exactly as without `--json`.

Run the automated checks, none of which consume Claude usage:

```sh
pnpm --filter @paseo-plugins/claude-tty-acp typecheck
pnpm --filter @paseo-plugins/claude-tty-acp test
pnpm --filter @paseo-plugins/claude-tty-acp build
```

Run a real end-to-end smoke test through ACP and an interactive Claude PTY:

```sh
pnpm --filter @paseo-plugins/claude-tty-acp smoke:live -- /absolute/project/path
```

The live smoke test asks Claude for a fixed tool-free response and consumes normal Claude usage.

## Upgrading and uninstalling

The adapter is updated and removed with the plugin, on each host independently; see the [plugin's installation notes](../../plugins/claude-tty/README.md#installation).
A running adapter process keeps the code it started with, so a rebuilt adapter reaches the sessions started after it.

Persistent session files are versioned and survive upgrades in the configured state directory.
Removing the plugin leaves that directory in place; remove it only if the session resume mappings are no longer needed.
