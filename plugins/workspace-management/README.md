# Workspace management

Apply host-managed metadata to Paseo workspaces. Its first policy shows each toolchain-box credential
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

The server runtime reads the host's own two files directly -- it runs in the daemon, on the host, so
there is nothing to copy and nothing to keep in step:

| File                                                 | What is read                                                     |
| ---------------------------------------------------- | ---------------------------------------------------------------- |
| `~/dotfiles/hosts/vps/credential-broker/boundaries`  | the boundary names the broker serves, one per remote-pattern line |
| `~/dotfiles/hosts/vps/toolchain-box/projects`        | `<main checkout> [<boundary>]`, one boxed project per line        |

Both are the host's line-oriented format: `#` starts a comment and fields are whitespace-separated.
A project's checkouts are its main one plus every worktree git has recorded under
`.git/worktrees`, which is the same rule `toolchain-box` itself resolves by, read from the same
place. `BOX_PROJECT_CONFIG` overrides the projects path; `WORKSPACE_MANAGEMENT_BOUNDARIES_PATH` and
`WORKSPACE_MANAGEMENT_BOX_PROJECT_CONFIG` override either, and the tests use them.

A workspace in none of those checkouts is running on the host itself, which is a trust zone of its
own and gets the `host` label. A boxed checkout whose line names no boundary, or one the broker no
longer declares, gets no label rather than an invented one.

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

## Settings

There are no app settings. Boundary membership remains host-owned configuration.

## Development

From the repository root:

```sh
pnpm --filter @paseo-plugins/workspace-management typecheck
pnpm --filter @paseo-plugins/workspace-management test
```

The tests use temporary host files and an in-memory Paseo API; they do not need a live daemon.
