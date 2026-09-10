/**
 * The provider this plugin registers with the daemon. The ID is the plugin's own: nothing else may
 * hold it, because the daemon refuses a plugin provider whose ID a builtin or the configuration
 * already claims.
 */
export const PROVIDER_ID = "claude-tty";

export const PROVIDER_LABEL = "Claude TTY";
