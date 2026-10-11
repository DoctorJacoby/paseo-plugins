# Tool-call details travel over a vendor method

The adapter sends a copy of every tool-call update over the vendor method `_claude_tty/tool_call`, ahead of the ACP `session/update`, and the plugin uses it to draw the card for that call.
The plugin SDK's ACP bridge builds tool cards without the ACP `content` blocks, so without the copy every shell command, search and subagent log would show as raw JSON, and none of the bridge's transformer hooks sees a `session/update` with its content.
The card mapping in `server/tool-details.ts` is a port of the daemon's own `mapToolDetail`, so it has to follow the daemon when that changes.
Drop the mirror once the SDK's bridge builds cards from the content blocks itself.
