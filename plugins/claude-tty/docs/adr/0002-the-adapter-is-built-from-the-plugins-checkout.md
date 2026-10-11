# The adapter is built from the plugin's own checkout

The plugin runs the adapter that sits in the same checkout it was installed from, built by the manifest's `build` commands at install and update, rather than an adapter installed from npm.
The adapter is private and links a native module (node-pty), so there is no published artefact to depend on, and building beside the plugin keeps the two at the same commit.
This is why installing needs `pnpm` on the daemon's `PATH` and a clone has to be built by hand before a directory install.
The **Adapter executable** setting is the escape hatch for hosts that cannot build: it names an adapter built elsewhere, and the plugin then ignores its checkout's.
