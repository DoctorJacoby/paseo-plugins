import type { BoundaryLabelDefinitions } from "./boundary-labels.ts";
import { HOST_BOUNDARY } from "./boundary-config.ts";

/**
 * Host trust zones are presentation policy, so their names and colours change in reviewable code
 * rather than in a settings pane. One entry per boundary the host's `trustcell/projects` actually
 * names, plus `host` for everything that runs outside a box -- which is the one that wants
 * noticing, hence red.
 *
 * A boundary with no entry here is simply not shown. That is deliberate: a new boundary appearing
 * in the host's files should not silently pick a colour out of the palette and look as if somebody
 * chose it.
 */
export const BOUNDARY_LABELS = {
  [HOST_BOUNDARY]: { name: HOST_BOUNDARY, color: "red" },
  "cebud-work": { name: "cebud-work", color: "sky" },
  "paseo-plugins": { name: "paseo-plugins", color: "violet" },
  paseo: { name: "paseo", color: "emerald" },
} as const satisfies BoundaryLabelDefinitions;
