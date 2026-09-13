import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { settingsDocument } from "../shared/settings.ts";
import { resolveAdapter } from "./adapter.ts";

/** A checkout the resolver would accept, with the wrapper and the build in whichever state is asked for. */
async function makeCheckout(root: string, { wrapper = true, built = true } = {}): Promise<string> {
  const adapter = path.join(root, "apps", "claude-tty-acp");
  await mkdir(path.join(root, "plugins", "claude-tty"), { recursive: true });
  await mkdir(path.join(adapter, "bin"), { recursive: true });
  await mkdir(path.join(adapter, "dist"), { recursive: true });
  await writeFile(path.join(adapter, "package.json"), "{}");
  if (wrapper) await writeExecutable(path.join(adapter, "bin", "claude-tty-acp"));
  if (built) await writeFile(path.join(adapter, "dist", "cli.js"), "");
  return path.join(root, "plugins", "claude-tty");
}

async function writeExecutable(filePath: string): Promise<string> {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, "#!/bin/sh\n");
  await chmod(filePath, 0o755);
  return filePath;
}

/** A host: the daemon's configuration, and the settings document the store would have written. */
async function withHost(
  run: (host: { home: string; env: { PASEO_HOME: string }; install: (pluginPath: string | null) => Promise<void>; configure: (executable: string) => Promise<void> }) => Promise<void>,
): Promise<void> {
  const home = await mkdtemp(path.join(os.tmpdir(), "claude-tty-adapter-"));
  try {
    await run({
      home,
      env: { PASEO_HOME: home },
      install: async (pluginPath) => {
        const plugins = pluginPath === null ? {} : { "claude-tty": { source: "directory", path: pluginPath } };
        await writeFile(path.join(home, "config.json"), JSON.stringify({ plugins }));
      },
      configure: async (executable) => {
        const values = settingsDocument.schema.parse({ adapterExecutable: executable });
        const file = path.join(home, "plugin-settings", "claude-tty", "settings.json");
        await mkdir(path.dirname(file), { recursive: true });
        await writeFile(file, JSON.stringify({ version: settingsDocument.version, values }));
      },
    });
  } finally {
    await rm(home, { force: true, recursive: true });
  }
}

async function withCheckout(run: (root: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(path.join(os.tmpdir(), "claude-tty-checkout-"));
  try {
    await run(root);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
}

test("runs the checkout's adapter when nothing is configured, which is what a clone installs", async () => {
  await withHost(async (host) => {
    await withCheckout(async (root) => {
      await host.install(await makeCheckout(root));

      const adapter = await resolveAdapter(host.env);
      assert.equal(adapter.executable, path.join(root, "apps", "claude-tty-acp", "bin", "claude-tty-acp"));
      assert.equal(adapter.source, "checkout");
      assert.equal(adapter.checkout.root, root);
      assert.equal(adapter.built, true);
      assert.equal(adapter.problem, null);
    });
  });
});

test("runs a configured adapter instead, and stops minding that there is no checkout", async () => {
  await withHost(async (host) => {
    await withCheckout(async (elsewhere) => {
      // The failure the setting exists for: an installation the daemon cloned for itself, whose
      // plugin directory is nowhere near a checkout this plugin could build an adapter in.
      await host.install(path.join(host.home, "plugins", "claude-tty", "abc-123", "checkout", "plugins", "claude-tty"));
      const executable = await writeExecutable(path.join(elsewhere, "claude-tty-acp"));
      await host.configure(executable);

      const adapter = await resolveAdapter(host.env);
      assert.equal(adapter.executable, executable);
      assert.equal(adapter.source, "configured");
      assert.equal(adapter.problem, null);
      assert.equal(adapter.built, true);
      // Still reported, because it is still true; it is no longer what makes the plugin unusable.
      assert.equal(adapter.checkout.root, null);
      assert.match(adapter.checkout.problem!, /does not exist/);
    });
  });
});

test("prefers the configured adapter over the checkout's, which is what makes it an override", async () => {
  await withHost(async (host) => {
    await withCheckout(async (root) => {
      await withCheckout(async (elsewhere) => {
        await host.install(await makeCheckout(root));
        const executable = await writeExecutable(path.join(elsewhere, "claude-tty-acp"));
        await host.configure(executable);

        const adapter = await resolveAdapter(host.env);
        assert.equal(adapter.executable, executable);
        assert.equal(adapter.source, "configured");
        assert.equal(adapter.checkout.root, root);
      });
    });
  });
});

test("falls back to the checkout when the setting is emptied again", async () => {
  await withHost(async (host) => {
    await withCheckout(async (root) => {
      await host.install(await makeCheckout(root));
      await host.configure("   ");

      const adapter = await resolveAdapter(host.env);
      assert.equal(adapter.source, "checkout");
      assert.equal(adapter.executable, path.join(root, "apps", "claude-tty-acp", "bin", "claude-tty-acp"));
    });
  });
});

test("says a configured path is missing rather than leaving it to the spawn", async () => {
  await withHost(async (host) => {
    await host.install(null);
    await host.configure("/nowhere/claude-tty-acp");

    const adapter = await resolveAdapter(host.env);
    assert.equal(adapter.executable, "/nowhere/claude-tty-acp");
    assert.equal(adapter.built, false);
    assert.match(adapter.problem!, /^\/nowhere\/claude-tty-acp does not exist\./);
  });
});

test("says a configured path is not executable, which a spawn would only say later", async () => {
  await withHost(async (host) => {
    await withCheckout(async (elsewhere) => {
      await host.install(null);
      const executable = path.join(elsewhere, "claude-tty-acp");
      await writeFile(executable, "#!/bin/sh\n");
      await chmod(executable, 0o644);
      await host.configure(executable);

      const adapter = await resolveAdapter(host.env);
      assert.match(adapter.problem!, /is not executable\.$/);
    });
  });
});

test("resolves a configured path that is relative, so the answer is one a daemon can spawn", async () => {
  await withHost(async (host) => {
    await host.install(null);
    await host.configure("./claude-tty-acp");

    const adapter = await resolveAdapter(host.env);
    assert.equal(adapter.executable, path.resolve("./claude-tty-acp"));
  });
});

test("still reports an unbuilt checkout, whose wrapper is committed and says nothing on its own", async () => {
  await withHost(async (host) => {
    await withCheckout(async (root) => {
      await host.install(await makeCheckout(root, { built: false }));

      const adapter = await resolveAdapter(host.env);
      assert.equal(adapter.built, false);
      assert.equal(adapter.buildWitness, path.join(root, "apps", "claude-tty-acp", "dist", "cli.js"));
      assert.match(adapter.problem!, /is not built — run the build in the checkout\.$/);
    });
  });
});

test("has nothing to run, and says which setting would give it something", async () => {
  await withHost(async (host) => {
    await host.install(null);

    const adapter = await resolveAdapter(host.env);
    assert.equal(adapter.executable, null);
    assert.equal(adapter.source, null);
    assert.equal(adapter.buildWitness, null);
    assert.match(adapter.problem!, /Set an adapter executable in this plugin's settings/);
  });
});

test("reads a document the store has not written yet as nothing configured", async () => {
  await withHost(async (host) => {
    await withCheckout(async (root) => {
      await host.install(await makeCheckout(root));
      // A host that has never opened the settings screen has no document at all, which is the
      // normal state and must not be the difference between a working plugin and a broken one.
      const adapter = await resolveAdapter(host.env);
      assert.equal(adapter.source, "checkout");
      assert.equal(adapter.problem, null);
    });
  });
});

test("reads a malformed document as nothing configured rather than failing every session over it", async () => {
  await withHost(async (host) => {
    await withCheckout(async (root) => {
      await host.install(await makeCheckout(root));
      const file = path.join(host.home, "plugin-settings", "claude-tty", "settings.json");
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(file, "{ not json");

      const adapter = await resolveAdapter(host.env);
      assert.equal(adapter.source, "checkout");
      assert.equal(adapter.problem, null);
    });
  });
});
