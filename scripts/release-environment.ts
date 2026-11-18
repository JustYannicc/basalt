import { deployEnvironment } from "./environment.ts";
import { releaseTarget } from "./release-barrier/release-stage.ts";
import { rehearsalReleaseEnvironment } from "./release-preview/rehearsal-environment.ts";

/**
 * The environment a release entry reads and writes with: production's, or a rehearsal stage's own,
 * derived the same way for every entry. An unknown stage refuses here.
 */
export const releaseEnvironment = (source: NodeJS.ProcessEnv = process.env) =>
  releaseTarget(source).rehearsal ? rehearsalReleaseEnvironment(source) : deployEnvironment(source);
