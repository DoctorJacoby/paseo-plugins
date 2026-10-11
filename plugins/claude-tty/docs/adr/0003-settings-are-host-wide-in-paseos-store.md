# Settings are host-wide, in Paseo's settings store

The idle timeout and the Auto Accept defaults are host settings in the store Paseo owns, not per-session ACP config options beside the model and effort pickers.
Paseo's store survives reloads and updates, gives one answer per host, and is deleted with the plugin; a session config option would give up all three.
The adapter is a separate process that cannot read that store, so the plugin writes it a resolved copy (`--settings-file`), which the adapter re-reads at every suspension and permission prompt so changes reach open sessions.
Auto Accept is the one exception that is also per agent: the toggle is a session config option, and the host settings only decide where it starts, because `paseo run` can set a mode but not a toggle.
