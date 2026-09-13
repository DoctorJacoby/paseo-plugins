import type { BoundaryLabelDefinitions } from "./boundary-labels.ts";

/** Host trust zones are presentation policy, so their names and colours change in reviewable code. */
export const BOUNDARY_LABELS = {
  "cebud-work": { name: "cebud-work", color: "orange" },
  "paseo-plugins": { name: "paseo-plugins", color: "sky" },
} as const satisfies BoundaryLabelDefinitions;
