# Working in this workspace

A pnpm workspace of Paseo plugins under `plugins/`, and the apps they run under `apps/`.
Paseo installs a plugin against its package directory, so `paseo-plugin.json` and the runtime entries sit at the package root, where the loader looks for them.
The entries are `index.client.tsx` (or `index.client.ts`) and `index.server.ts`, either or both.
Every other module lives under `client/`, `server/` or `shared/`, and that directory decides which bundle it joins.

Dependencies belong to the package that uses them, not the root, because the daemon's esbuild resolves from the plugin directory.

Paseo documents the plugin contract at `public-docs/plugins/reference.md` in `getpaseo/paseo`, with `providers.md`, `publishing.md` and `migration.md` beside it.
Read it before inferring a rule from a failed build.

A package's CLAUDE.md holds only what an agent cannot find out from the code, `git log` or that reference: the traps that break something when you don't know them.
Decisions with a real trade-off go in an ADR instead (see **Domain docs** below).

## Plugin READMEs

A README is for someone installing and using the plugin.
Internals, rationale and history stay out of it.
A change updates the section it belongs to rather than appending a paragraph, and leaves out what the UI already tells the user.
Write short, plain sentences, one per line.

Every plugin's README follows this template; sections marked optional are dropped when there is nothing to put in them:

````md
# plugin name

<one or two sentences on what it does for the user>

## Screenshots (optional)

## Installation

Requires:

- Paseo <version> or newer
- <anything else the daemon's host needs>

```sh
paseo plugin add github:sleeyax/paseo-plugins:plugins/<name>
```

Also available as `sleeyax/<name>` on [Paseo Community Plugins](https://paseo.sh/plugins) and on [Paseo Cafe](https://paseo.cafe/plugins/<name>).
<only when the plugin is listed there>

Update with `paseo plugin update <name>`.
To install from source, see the [root README](../../README.md#from-source).

<plugin-specific notes, if any>

## Usage

<one ### per thing a user does with it, written as how to do it>

## Settings (optional)

<a table of setting, default, and what it does>

## Troubleshooting (optional)

<only the problems whose fix the message itself does not give>

## Development

For development instructions, see the [root README](../../README.md#development).

<anything else this package needs, if any>

Design decisions are in [docs/adr](docs/adr).
<only when the package has ADRs>

## License and attributions (optional)
````

## Repository skills

The repository's own skills live in `skills/`.
`.claude/skills/` and `.agents/skills/` hold one symlink per skill into it, so a new skill goes in `skills/` with a link in each, or only one harness sees it.

## Agent skills

### Issue tracker

Issues live in GitHub Issues on sleeyax/paseo-plugins, managed with the `gh` CLI.
See `docs/agents/issue-tracker.md`.

### Triage labels

The five default triage labels, each label string equal to its role name.
See `docs/agents/triage-labels.md`.

### Domain docs

Multi-context: each plugin and app is its own context whose decisions go in its own `docs/adr/`, and `docs/adr/` at the root holds workspace-wide decisions.
No glossary exists yet; `/domain-modeling` creates `GLOSSARY-MAP.md` and a context's `GLOSSARY.md` once terms get settled.
See `docs/agents/domain.md`.
