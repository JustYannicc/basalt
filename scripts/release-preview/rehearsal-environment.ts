import { stageEnvironment } from "../environment.ts";
import { subjectFromStage } from "../preview/subject.ts";
import { isRehearsalStage } from "../release-barrier/release-stage.ts";

/** Release identity and controls pass through; everything else is the disposable stage's own. */
const releaseInputs = [
  "BASALT_RELEASE_CANDIDATE",
  "BASALT_RELEASE_ATTEMPT",
  // Production's release runner passes these so the deploy publishes its pool image receipt.
  "BASALT_POOL_IMAGE_RECEIPT",
  "GITHUB_SHA",
  "BASALT_REHEARSAL_STOP",
  "BASALT_REHEARSAL_DRAIN_CAP_MS",
  "POOL_AVAILABILITY_TARGET",
  // The stage's sign-in seed re-runs on every deploy and writes a fresh output each time.
  "PREVIEW_AUTH_SEED_OUTPUT",
  "GITHUB_ACTIONS",
  "GITHUB_REF",
  "GITHUB_JOB",
  "GITHUB_REPOSITORY",
  "GITHUB_WORKFLOW_REF",
  "GITHUB_RUN_ID",
  "GITHUB_RUN_ATTEMPT",
  "GITHUB_STEP_SUMMARY",
] as const;

/**
 * The environment `scripts/deploy.ts` releases a rehearsal stage with. It never reads production
 * keys: the stage derives its own, so nothing it signs is accepted by production.
 */
export function rehearsalReleaseEnvironment(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  if (!isRehearsalStage(source.ALCHEMY_STAGE))
    throw new Error("A rehearsal release needs a rehearsal stage");
  const subject = subjectFromStage(source.ALCHEMY_STAGE);
  if (subject?.kind !== "rehearsal") throw new Error("A rehearsal release needs a rehearsal stage");
  const stage = stageEnvironment(subject, source);
  const environment: NodeJS.ProcessEnv = { ...stage.deploy, ...stage.seed };
  for (const name of releaseInputs) if (source[name]) environment[name] = source[name];
  // Production watches its clean pool, which needs a Sentry destination; a rehearsal reports to its own.
  if (environment.POOL_AVAILABILITY_TARGET) {
    if (!source.RELEASE_REHEARSAL_SENTRY_DSN?.trim())
      throw new Error("Missing GitHub Actions secret: RELEASE_REHEARSAL_SENTRY_DSN");
    environment.SENTRY_DSN = source.RELEASE_REHEARSAL_SENTRY_DSN;
  }
  return environment;
}
