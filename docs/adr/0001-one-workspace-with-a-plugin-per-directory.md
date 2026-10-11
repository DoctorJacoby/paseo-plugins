# One workspace, with a plugin per directory

All plugins live in this one pnpm workspace, each in its own package directory that Paseo installs directly, as in `paseo plugin add github:sleeyax/paseo-plugins:plugins/<name>`.
That lets plugins share an app they run (such as `claude-tty-acp`) and the repository's tooling, at the cost of every package root being a plugin root: the manifest and runtime entries must sit there, and each package carries its own dependencies because the daemon resolves imports from the plugin directory.
Install sources and registry entries name these paths, so moving a plugin breaks existing installations.
