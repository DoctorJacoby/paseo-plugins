import { PLUGIN_ID, PLUGIN_LABEL } from "./identity.ts";

/**
 * The provider this plugin registers with the daemon. The ID is the plugin's own: nothing else may
 * hold it, because the daemon refuses a plugin provider whose ID a builtin or the configuration
 * already claims — which is exactly what a second copy of this plugin would be, and why both come
 * from `./identity.ts`.
 */
export const PROVIDER_ID = PLUGIN_ID;

export const PROVIDER_LABEL = PLUGIN_LABEL;
