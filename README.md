# Paseo plugins and apps

Extensions for [Paseo](https://github.com/getpaseo/paseo), organized in a pnpm workspace.

| App | Description |
| --- | --- |
| [Claude TTY ACP](apps/claude-tty-acp) | Run genuine interactive Claude Code sessions in Paseo's native agent view. |

| Plugin | Description |
| --- | --- |
| [Discord Rich Presence](plugins/discord-rich-presence) | Show your current Paseo activity on Discord. |
| [Catppuccin theme](plugins/catppuccin-theme) | Add all four Catppuccin flavours as app themes. |
| [Claude TTY](plugins/claude-tty) | Offer the Claude TTY ACP adapter as a Paseo provider, and manage it on the daemon host. |

Each app and plugin has its own README with installation, settings, and development details.

## Local development

Install dependencies and check every package from the repository root:

```sh
pnpm install
pnpm typecheck
pnpm test
```

Enable Paseo plugins, then install each plugin by its directory in this repository:

```sh
paseo plugin add sleeyax/paseo-plugins --path plugins/discord-rich-presence
paseo plugin ls
```

Paseo clones the repository itself and tracks the default branch, so `paseo plugin update <id>` and `paseo plugin status` keep an installation current. `claude-tty` is the one that asks something of the host: it runs an adapter that has to be built, so installing and updating it run the `build` commands in its manifest and it needs `pnpm` on the daemon's `PATH`.

To work on a plugin, install it from the working copy instead. A directory installation runs no `build`, so build what it needs first:

```sh
paseo plugin add "/absolute/path/to/paseo-plugins/plugins/discord-rich-presence"
```

After making changes, run `paseo plugin reload <id>`. Paseo does not hot-reload plugins, and reloading is the compile check for the client and server bundles built from `index.client.tsx` and `index.server.ts`.

## Plugin settings

Plugin settings are stored in `~/.cache/paseo-plugins/<plugin-id>/settings.json`.
