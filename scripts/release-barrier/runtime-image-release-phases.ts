/** Each retained phase of the runtime image release; the coverage gate enumerates them from here. */
export const runtimeReleasePhases = [
  "controller",
  "bind-blue",
  "bind-green",
  "inactive-image",
  "final-settings",
] as const;
export type RuntimeReleasePhase = (typeof runtimeReleasePhases)[number];
