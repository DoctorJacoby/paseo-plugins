#!/usr/bin/env node
// Give this checkout's copy of the plugin an identity of its own, so a second copy can be
// installed beside the first (#38).
//
//   pnpm identity                    print what this checkout builds as
//   pnpm identity --check            exit non-zero if the four places disagree
//   pnpm identity claude-tty-dev     stamp that ID everywhere it has to appear
//   pnpm identity claude-tty         stamp it back
//
// It writes four files, because the ID has to be in four places and no two of them can read each
// other:
//
//   paseo-plugin.json                    the manifest, which is what the daemon keys on
//   shared/identity.ts                   the plugin's own copy: the provider ID, the label, and
//                                        the adapter state directory derived from it
//   ../../apps/claude-tty-acp/src/constants.ts
//                                        the adapter's copy of that directory name. The adapter
//                                        is a package of its own and the plugin runs inside the
//                                        daemon, so neither can import the other's
//   README.md                            is left alone: it documents both variants in prose
//
// Nothing here is generated at runtime or at build. The daemon compiles the plugin from source
// with no build step of its own, and a directory install runs the manifest's `build` commands not
// at all, so a generated file would have to be committed or would be missing exactly where it is
// needed. Stamping the checkout keeps one literal per name, keeps `git diff` honest about what a
// variant is, and is the same thing the issue described doing by hand.
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const PLUGIN_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const REPO_ROOT = path.resolve(PLUGIN_DIR, "..", "..");

const MANIFEST = path.join(PLUGIN_DIR, "paseo-plugin.json");
const IDENTITY = path.join(PLUGIN_DIR, "shared", "identity.ts");
const ADAPTER_CONSTANTS = path.join(REPO_ROOT, "apps", "claude-tty-acp", "src", "constants.ts");

const BASE_ID = "claude-tty";
const BASE_LABEL = "Claude TTY";

/** The daemon's own rule for a plugin ID, quoted in plugins/claude-tty/CLAUDE.md. */
const ID_PATTERN = /^[a-z][a-z0-9._-]*$/;

/** What the adapter's state directory is called for a given ID; shared/identity.ts computes the same. */
const stateDirectoryFor = (id) => `${id}-acp`;

/**
 * A readable label for an ID, so that the common case takes no second argument. Only this plugin's
 * own family is guessed at: anything else has to say what it is called, because turning an
 * arbitrary ID into prose is how a sidebar ends up reading "Claude Tty".
 */
function labelFor(id) {
  if (id === BASE_ID) return BASE_LABEL;
  if (id.startsWith(`${BASE_ID}-`)) return `${BASE_LABEL} (${id.slice(BASE_ID.length + 1)})`;
  return null;
}

const single = (pattern, text, what, file) => {
  const found = text.match(new RegExp(pattern.source, `${pattern.flags}g`));
  if (!found || found.length !== 1) {
    throw new Error(`${path.relative(REPO_ROOT, file)}: expected exactly one ${what}, found ${found?.length ?? 0}`);
  }
  return text.match(pattern);
};

async function read() {
  const manifestText = await readFile(MANIFEST, "utf8");
  const identityText = await readFile(IDENTITY, "utf8");
  const adapterText = await readFile(ADAPTER_CONSTANTS, "utf8");
  return {
    manifestText,
    identityText,
    adapterText,
    manifestId: single(/^ {2}"id": "([^"]+)",$/m, manifestText, '"id" line', MANIFEST)[1],
    identityId: single(/^export const PLUGIN_ID = "([^"]+)";$/m, identityText, "PLUGIN_ID", IDENTITY)[1],
    identityLabel: single(/^export const PLUGIN_LABEL = "([^"]+)";$/m, identityText, "PLUGIN_LABEL", IDENTITY)[1],
    adapterName: single(/^export const APP_NAME = "([^"]+)";$/m, adapterText, "APP_NAME", ADAPTER_CONSTANTS)[1],
  };
}

function disagreements(state) {
  const out = [];
  if (state.manifestId !== state.identityId) {
    out.push(`paseo-plugin.json says "${state.manifestId}" and shared/identity.ts says "${state.identityId}"`);
  }
  const wanted = stateDirectoryFor(state.identityId);
  if (state.adapterName !== wanted) {
    out.push(
      `apps/claude-tty-acp/src/constants.ts says APP_NAME "${state.adapterName}", ` +
        `and the plugin's ID "${state.identityId}" makes the state directory "${wanted}" — ` +
        `the two copies would read different directories`,
    );
  }
  return out;
}

async function write(id, label) {
  const state = await read();
  // The one line, and not a reparse: `JSON.stringify` would reflow the manifest's hand-kept
  // one-line arrays, so stamping the ID a checkout already has would show up as a diff.
  await writeFile(MANIFEST, state.manifestText.replace(/^ {2}"id": "[^"]+",$/m, `  "id": "${id}",`));
  await writeFile(
    IDENTITY,
    state.identityText
      .replace(/^export const PLUGIN_ID = "[^"]+";$/m, `export const PLUGIN_ID = "${id}";`)
      .replace(/^export const PLUGIN_LABEL = "[^"]+";$/m, `export const PLUGIN_LABEL = "${label}";`),
  );
  await writeFile(
    ADAPTER_CONSTANTS,
    state.adapterText.replace(/^export const APP_NAME = "[^"]+";$/m, `export const APP_NAME = "${stateDirectoryFor(id)}";`),
  );
}

function describe(state) {
  return [
    `plugin and provider ID   ${state.identityId}`,
    `label                    ${state.identityLabel}`,
    `adapter state directory  ~/.local/state/${state.adapterName}`,
  ].join("\n");
}

async function main(argv) {
  const args = argv.slice(2);
  let label = null;
  const rest = [];
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === "--label") {
      label = args[i + 1];
      i += 1;
    } else {
      rest.push(args[i]);
    }
  }

  const check = rest.includes("--check");
  const id = rest.find((a) => !a.startsWith("-"));

  if (!id) {
    const state = await read();
    const wrong = disagreements(state);
    console.log(describe(state));
    if (wrong.length > 0) {
      console.error(`\nThese do not agree:\n${wrong.map((w) => `  - ${w}`).join("\n")}`);
      console.error(`\n\`pnpm identity ${state.identityId}\` writes all of them from the one ID.`);
      process.exitCode = 1;
      return;
    }
    if (check) console.log("\nAll four agree.");
    return;
  }

  if (!ID_PATTERN.test(id)) {
    console.error(`"${id}" is not a plugin ID: the daemon wants ${ID_PATTERN}`);
    process.exitCode = 1;
    return;
  }
  const resolved = label ?? labelFor(id);
  if (!resolved) {
    console.error(`"${id}" is outside this plugin's own naming, so it needs --label "<what to call it>"`);
    process.exitCode = 1;
    return;
  }

  await write(id, resolved);
  console.log(describe(await read()));
  console.log(
    `\nBuilt from here, this checkout installs as "${id}".` +
      `\nThe adapter has to be rebuilt for the state directory to follow:` +
      `\n  pnpm install --frozen-lockfile && pnpm --filter @paseo-plugins/claude-tty-acp build` +
      `\n  paseo plugin add "${PLUGIN_DIR}"`,
  );
}

await main(process.argv);
