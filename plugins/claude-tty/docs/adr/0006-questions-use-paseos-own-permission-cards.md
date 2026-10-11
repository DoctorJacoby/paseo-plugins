# Questions and plans use Paseo's own permission cards

Claude's questions and plans are rebuilt as `kind: "question"` and `kind: "plan"` permissions that Paseo's own question form and plan card draw, rather than drawn by a timeline renderer of the plugin's own.
The host's question form already handles several questions, multi-select and free-text answers, and it is the only path in the app that returns `updatedInput`.
ACP carries only the chosen option back to the adapter, so the plugin writes the answers to a file under the adapter's `--answers-dir` before forwarding the response, and the adapter reads them from there.
