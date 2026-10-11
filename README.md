# Paseo plugins and apps

My plugins for [Paseo](https://github.com/getpaseo/paseo).

## Overview

| Plugin                                                 | Description                                                                                            |
| ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------ |
| [Discord Rich Presence](plugins/discord-rich-presence) | Show your current Paseo activity on Discord.                                                           |
| [Catppuccin theme](plugins/catppuccin-theme)           | Add all four Catppuccin flavours as app themes.                                                        |
| [Claude TTY](plugins/claude-tty)                       | Offer the Claude TTY ACP adapter as a Paseo provider, and manage it on the daemon host.                |
| [Guided Review](plugins/guided-review)                 | Show a trunk-first guide to a pull request or merge request, and build your draft review alongside it. |

| ACP                                   | Description                                                                |
| ------------------------------------- | -------------------------------------------------------------------------- |
| [Claude TTY ACP](apps/claude-tty-acp) | Run genuine interactive Claude Code sessions in Paseo's native agent view. |

## Installation

Check each plugin's README for the Paseo version and anything else it may depend on.
A plugin installed from GitHub or a registry can be updated with `paseo plugin update <id>`.
From GitHub that installs the latest commit on `main`, and from a registry the revision the registry last approved.

### From GitHub (recommended)

```sh
paseo plugin add github:sleeyax/paseo-plugins:plugins/discord-rich-presence
```

### From a registry

Some plugins are also listed in a plugin registry:

- [Paseo Community Plugins](https://paseo.sh/plugins): install by the registry ID the plugin's README gives, such as `paseo plugin add sleeyax/discord-rich-presence`.
  It needs Paseo 0.11 or newer.
- [Paseo Cafe](https://paseo.cafe): copy the install command from the plugin's page.

### From source

To run changes of your own, install from a clone instead:

1. Clone this repository and install its dependencies:

   ```sh
   git clone https://github.com/sleeyax/paseo-plugins.git
   cd paseo-plugins
   pnpm install
   ```

2. Run the `build` commands in the plugin's `paseo-plugin.json` from its directory, if it has any.

3. Install the plugin from the clone:

   ```sh
   paseo plugin add "/absolute/path/to/paseo-plugins/plugins/discord-rich-presence"
   ```

To update:

- Run `git pull`
- Repeat the build steps
- Run `paseo plugin reload <id>`.

Alternatively, run the `update-plugins` [skill](#skills). It does all the update steps above for every plugin installed from the clone.

## Development

Install the plugin you are working on [from source](#from-source), then:

1. After each change, reload the plugin, and read its logs if something broke:

   ```sh
   paseo plugin reload <name>
   paseo plugin logs <name>
   ```

2. Typecheck and test the package you are working on:

   ```sh
   pnpm --filter @paseo-plugins/<name> typecheck
   pnpm --filter @paseo-plugins/<name> test
   ```

   Or every package at once, from the repository root:

   ```sh
   pnpm typecheck
   pnpm test
   ```

`<name>` is the package's directory name, which is also its plugin ID.

Each plugin's README has anything else specific to it in its own Development section.

### Skills

This repository comes with its own set of local skills to aid in development:

| Skill                 | Description                                                                                                                                                                                                   |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `update-plugins`      | Rebuild the apps and reload the plugins this host has installed from this checkout.                                                                                                                           |
| `adopt-paseo-release` | Review the Paseo releases since the last review and file an issue with what the plugins should adopt. Runs only when invoked by name: `/adopt-paseo-release` in Claude Code, `$adopt-paseo-release` in Codex. |

### Releasing a plugin

Releases are automatic, so there is no version to bump or changelog to write by hand.
[release-please](https://github.com/googleapis/release-please) reads the conventional commits on `main` and keeps a release pull request open; merging it releases.

A `feat` releases a minor version, a `fix` a patch version, and `chore` or `docs` nothing. A breaking change, marked with `!` after the type (`feat!: ...`) or a `BREAKING CHANGE:` footer, releases a major version. To release a specific version instead, add a `Release-As: 1.0.0` footer to the commit.

The package a commit releases is the one whose files it touches, so try to keep each commit inside one package.
