# The adapter stays a subprocess, not an in-process connector

`runAcpProvider` takes either a `command` or a `connector`, and the plugin uses `command`, so each ACP session runs in its own adapter process.
A `connector` runs in the plugin's process and is called with no arguments, so every session would share the plugin worker's environment and lose the per-agent `PASEO_AGENT_ID` the daemon passes to a spawned process, which tools inside Claude key on (such as a `glab` wrapper that posts as a bot per agent).
A native crash in process would also take down the plugin, and the daemon then closes every agent on the provider with no automatic restart, whereas a wedged subprocess is one session with a **Stop** button.
Revisit if the SDK passes the session's configuration, including its environment, to the connector.
