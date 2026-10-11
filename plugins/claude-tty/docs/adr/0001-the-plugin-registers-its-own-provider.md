# The plugin registers its own provider

The plugin registers `claude-tty` as a plugin provider through `registerProvider`, with its own ID, label and icon, and runs the adapter from `connect()`.
Earlier versions instead patched `agents.providers` in the daemon configuration from outside, under the borrowed `traecli` provider ID, because the daemon only waited for a provider's initial slash commands when its ID was `traecli`.
Paseo 0.8 let a plugin own a provider and ask for that wait through `acpOptions`, which removed the install, repair and uninstall machinery and let the plugin wrap the ACP connection to fix up cards, subsessions and steering.
The cost is that every session on the provider lives inside the plugin process, so reloading the plugin stops all of them.
An upgraded host keeps the old `traecli` entry until someone removes it; the plugin reports it and never deletes it, because agents started on it cannot resume once it is gone.
