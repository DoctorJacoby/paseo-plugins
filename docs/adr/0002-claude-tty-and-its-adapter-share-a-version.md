# `claude-tty` and its adapter share a version

release-please links the versions of `claude-tty` and `claude-tty-acp`, so a release of either bumps both.
The plugin builds and runs the adapter from its own checkout, and installations only update when the plugin's version moves, so an adapter fix released under the adapter's version alone would never reach anyone.
