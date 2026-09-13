# Workspace management

Apply host-managed metadata to Paseo workspaces. Its first policy shows each toolchain-box credential
boundary as a workspace label.

## Installation

Install from the plugin repository:

```sh
paseo plugin add sleeyax/paseo-plugins --path plugins/workspace-management
paseo plugin status
```

`paseo plugin update workspace-management` picks up later versions.

The server runtime reads the credential-broker boundary map directly from
`~/dotfiles/hosts/vps/credential-broker/boundaries` and the box-project project map from
`~/dotfiles/hosts/vps/toolchain-box/projects`. `BOX_PROJECT_CONFIG` can point at the latter when the
host keeps it elsewhere. Both files are JSON; either may be a directory of JSON fragments. Tests can
override both paths with `WORKSPACE_MANAGEMENT_BOUNDARIES_PATH` and
`WORKSPACE_MANAGEMENT_BOX_PROJECT_CONFIG`.

The plugin fixes the managed label names and colours in `server/labels.ts`. It corrects their catalog
colours and adds the applicable label after each workspace creation. Plugin startup repeats that work
for every active workspace, so upgrading or reinstalling is a safe backfill. Reconciliation is
additive: it never removes any workspace label.

## Settings

There are no app settings. Boundary membership remains host-owned configuration.

## Development

From the repository root:

```sh
pnpm --filter @paseo-plugins/workspace-management typecheck
pnpm --filter @paseo-plugins/workspace-management test
```

The tests use temporary host maps and an in-memory Paseo label client; they do not need a live daemon.
