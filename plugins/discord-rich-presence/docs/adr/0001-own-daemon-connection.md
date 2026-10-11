# The server keeps its own connection to the daemon

A plugin server only gets a `paseo` handle inside an RPC call or a lifecycle hook, and no hook fires when the daemon starts.
Waiting for one would leave Discord blank until someone opens the panel or an agent does something.
So `server/daemon.ts` opens its own websocket from `contribute`, the way the CLI does, and subscribes to workspace and agent updates.

## Consequences

- The plugin resolves the daemon's address and password itself, and cannot dial a daemon that listens on a Unix socket or named pipe.
- The connection must close in the contribution's cleanup, or a reload waits on it.
