# Workspace management

Apply host-managed metadata to Paseo workspaces. Its first policy shows each TrustCell credential
boundary as a workspace label, so which trust zone a session runs in is a coloured chip on its
sidebar row in every client instead of something you remember.

## Requirements

**A daemon whose plugin API can write workspace labels.** Labels have been a first-class daemon
feature since 0.8, but `createPaseoApi` did not surface them, so the `PaseoApi` a plugin is injected
had no way to assign one. That is
[`feat/plugin-api-workspace-labels`](https://github.com/DoctorJacoby/paseo/tree/feat/plugin-api-workspace-labels),
filed upstream and carried on this host's served daemon build in the meantime. On a daemon without
it the plugin loads and then refuses at its first workspace event, saying so by name; it does not
fall back to reaching past the injected API into the daemon client's internals.

## Installation

Install from the plugin repository:

```sh
paseo plugin add sleeyax/paseo-plugins --path plugins/workspace-management
paseo plugin status
```

`paseo plugin update workspace-management` picks up later versions.

## Host configuration

The server runtime reads TrustCell's own two files directly -- it runs in the daemon, on the host, so
there is nothing to copy and nothing to keep in step:

| File                                            | What is read                                                        |
| ----------------------------------------------- | ------------------------------------------------------------------- |
| `~/dotfiles/hosts/vps/trustcell/boundaries`     | the boundary names the broker serves, one per remote-pattern line    |
| `~/dotfiles/hosts/vps/trustcell/projects`       | `<main checkout> [<boundary>]`, one boxed project per line           |

Both are TrustCell's line-oriented format: `#` starts a comment and fields are whitespace-separated.
A project's checkouts are its main one plus every worktree git has recorded under
`.git/worktrees`, which is the same rule TrustCell itself resolves by, read from the same
place. `BOX_PROJECT_CONFIG` overrides the projects path; `WORKSPACE_MANAGEMENT_BOUNDARIES_PATH` and
`WORKSPACE_MANAGEMENT_BOX_PROJECT_CONFIG` override either, and the tests use them.

A workspace in none of those checkouts is running on the host itself, which is a trust zone of its
own and gets the `host` label. A boxed checkout whose line names no boundary, or one the broker no
longer declares, gets no label rather than an invented one.

Reading another program's configuration behind its back drifts the moment that configuration moves,
and it has: when dotfiles `63b867f` folded `credential-broker/` and `toolchain-box/` into
`trustcell/`, this plugin read the old paths, found nothing, and badged every workspace `host`.
Asking `trustcell session <cwd>` for its own answer is the better shape and stays the intended
direction -- `apps/claude-tty-acp/src/session-placement.ts` already parses that CLI's `<key>
<value>` lines and is the parser to reuse. It is not done here yet for two reasons. The contract
cannot be exercised from a session box, where `trustcell` is a host binary that is not on `PATH`,
and an unverified parser of another tool's output is this same bug one layer further in. And the
question differs: `session` answers *where a session may run*, including `refuse` for a directory
that may host none, where a label only wants to know which boundary a workspace that already
exists sits in. Until someone can run it on the host, the paths live in one constant at the top of
`server/boundary-config.ts`, and the failure mode below is the guard.

### What happens when a file is missing

Failure is closed. If the projects map cannot be read at all, which checkouts are boxed is unknown,
so **no** workspace is labelled and the plugin logs why. A missing file is not evidence that
everything runs on the host -- it is evidence of nothing, and `host` is the loudest thing this
plugin can say. That is distinct from a map that is present and simply does not list a root: there
the host has spoken, and `host` is the right answer.

A missing boundaries list alone is less severe: boxed checkouts are still known but no boundary
counts as declared, so they go unlabelled while workspaces outside every boxed checkout are still
the host. It is logged too.

## Labels

The managed names and colours are fixed in `server/labels.ts` -- presentation policy, so it changes
in reviewable code rather than in a settings pane. A boundary with no entry there is not shown.

The plugin corrects a managed label's catalog colour and adds the applicable label when a workspace
is created. The first such event also sweeps every workspace already open, so installing or
upgrading backfills the sidebar. It is lazy rather than run at startup because the server runtime
hands a plugin its `PaseoApi` on a hook context and nowhere else: before the first event there is no
daemon to ask.

Reconciliation is additive. It never removes a label, because a label on a workspace may have been
put there by a human, including one that looks like an old boundary.

### Repairing a label that is provably wrong

Additive reconciliation means a wrong assignment cannot heal itself: a workspace badged `host` by
the stale-paths bug above keeps that chip forever, even once the paths are right, because nothing
ever takes one off.

Setting `WORKSPACE_MANAGEMENT_REPAIR_LABELS=1` in the daemon's environment turns the next run's
reconciliation into a repair pass. It is deliberately narrow, and it is not a new default:

- it acts only on a workspace whose boundary **resolved** to a managed label -- never on an unknown
  boundary, and never when the config could not be read;
- it removes only the *other* labels in `server/labels.ts`, so the host has positively contradicted
  each one it takes off;
- a human's own labels are not in `server/labels.ts` and are therefore never touched;
- every removal is logged with the workspace and the boundary that justified it.

To clear a bad sweep, on the host:

```sh
printf 'WORKSPACE_MANAGEMENT_REPAIR_LABELS=1\n' >> ~/.config/paseo/env
systemctl --user restart paseo        # whichever unit runs the daemon
# open any workspace: the first workspace.created event sweeps every workspace already open
sed -i '/^WORKSPACE_MANAGEMENT_REPAIR_LABELS=/d' ~/.config/paseo/env
systemctl --user restart paseo
```

Leaving the variable set is not harmful -- the pass is idempotent and only ever contradicts the
host's own answer -- but removing a label should stay a thing somebody asked for.

Failing that, labels live in the daemon's `~/.paseo/projects/workspaces.json`; editing that by hand
with the daemon stopped is the manual fix.

## Settings

There are no app settings. Boundary membership remains host-owned configuration.

## Development

From the repository root:

```sh
pnpm --filter @paseo-plugins/workspace-management typecheck
pnpm --filter @paseo-plugins/workspace-management test
```

The tests use temporary host files and an in-memory Paseo API; they do not need a live daemon.
