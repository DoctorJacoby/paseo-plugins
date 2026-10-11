# Discord Rich Presence

[![Paseo Cafe](https://img.shields.io/badge/Paseo_Cafe-discord--rich--presence-blue)](https://paseo.cafe/plugins/discord-rich-presence)

Show your current Paseo activity on your Discord profile.

## Screenshots

![Discord presence with project details](./docs/screenshots/presence2.png)

![Discord presence with workspace status](./docs/screenshots/presence1.png)

![Discord presence with a finished turn](./docs/screenshots/presence3.png)

## Installation

Requires:

- Paseo 0.11 or newer
- The Discord desktop app, running on the same machine as the Paseo daemon

```sh
paseo plugin add github:sleeyax/paseo-plugins:plugins/discord-rich-presence
```

Also available as `sleeyax/discord-rich-presence` on [Paseo Community Plugins](https://paseo.sh/plugins) and on [Paseo Cafe](https://paseo.cafe/plugins/discord-rich-presence).

Update with `paseo plugin update discord-rich-presence`.
To install from source, see the [root README](../../README.md#from-source).

Native, Snap and Flatpak installs of Discord all work.

## Usage

### Open the panel

Select **Discord** in the Paseo sidebar.
The panel shows the connection status, a preview of your presence, and the settings.
The presence starts on its own, and reconnects when you start Discord later.

### Choose how much to show

The detail level decides how much of your work reaches your profile:

| Level | Example |
| --- | --- |
| Detailed | `paseo-plugins — main` and `3 workspaces · 1 agent running` |
| Projects only | `paseo-plugins` and `3 workspaces` |
| Hidden | `Using Paseo` |

Discord names one project at a time, and the second line counts only that project.

Set the level for every project with **All projects**.
To give one project its own level, change it in the list below.
Workspace titles can contain task details, so check them before you leave a project on **Detailed**.

You can also search the Command Center for `Discord rich presence`.
It turns the presence on or off, and from a workspace it sets the level of that workspace's project.

When no workspace has been active for 30 minutes, Discord shows only `Using Paseo`.

### Read the status badge

The small badge shows the state of the workspace Discord names:

| Badge | State |
| --- | --- |
| Amber | Waiting for permission |
| Red | Failed |
| Blue | Running |
| Green | Finished and waiting for you |
| Grey | Idle |

The green badge can appear briefly each time an agent finishes a turn.
It clears once you view the session.

### Use your own Discord application

By default, the presence uses a shared Paseo application.
To use your own instead:

1. Create an application in the [Discord Developer Portal](https://discord.com/developers/applications). Its name becomes the bold title of your presence.
2. Copy its **Application ID** from **General Information**.
3. Under **Rich Presence → Art Assets**, upload the six images from [`assets/`](./assets). Keep their file names as the asset keys.
4. In the panel, open **Advanced**, paste the Application ID, and select **Save**.

Discord can take a few minutes to process new artwork.

## Settings

| Setting | Default | What it does |
| --- | --- | --- |
| Show my activity on Discord | On | Turns the presence on or off. Turning it off removes it from your profile at once. |
| All projects | Detailed | The detail level every project follows. |
| A project's level | Default | Overrides the detail level for that project. |
| Application ID | The shared Paseo application | The Discord application your presence appears under. |

## Troubleshooting

| Message | What to do |
| --- | --- |
| **Discord is not running — retrying…** while Discord is open | The plugin looks for Discord's socket only in the first of `$XDG_RUNTIME_DIR`, `$TMPDIR`, `$TMP`, `$TEMP` that is set in the daemon's environment, else in `/tmp`. Run the daemon as the same user as Discord, with the same `XDG_RUNTIME_DIR`. |
| **Discord refused this application ID** | Check the ID in the Developer Portal. The plugin tries again only after you save a different ID, or turn the presence off and on. |
| **Cannot read Paseo** | The plugin reads the daemon address from `PASEO_HOST`, `PASEO_LISTEN`, `$PASEO_HOME/paseo.pid`, then `daemon.listen` in `$PASEO_HOME/config.json`, and falls back to `127.0.0.1:6767`. If the daemon needs a password, set `PASEO_PASSWORD` in the daemon's environment. |
| The badge or icon has no image | Check that each asset key matches its file name, then give Discord a few minutes. |

Run `paseo plugin logs discord-rich-presence` for more detail.

## Development

For development instructions, see the [root README](../../README.md#development).

To regenerate the artwork in `assets/` after Paseo changes its own, run this against a Paseo checkout:

```sh
scripts/render-assets.sh /path/to/paseo
```

The script needs ImageMagick (`magick`) and `rsvg-convert`.

Design decisions are in [docs/adr](docs/adr).

## License and attributions

The images in `assets/` are derived from the Apache-2.0 artwork in [getpaseo/paseo](https://github.com/getpaseo/paseo/tree/main/packages/app/assets/images).
That licence grants no right to Paseo's name or trademarks.
