import { Schema } from "effect";
import { BarrierRefusal } from "./refusal.ts";

/**
 * Where a release runs. Production is the default; the only other stage is a disposable rehearsal
 * stack, which has its own stage, stack name and keys so neither can accept the other's records.
 */
export type ReleaseTarget = {
  readonly stack: string;
  readonly stage: string;
  readonly rehearsal: boolean;
};

export const productionRelease: ReleaseTarget = {
  stack: "basalt",
  stage: "production",
  rehearsal: false,
};
export const rehearsalStack = "basalt-rehearsal";
const rehearsalStage = /^test-rehearsal-[1-9][0-9]{0,9}$/u;

export const isRehearsalStage = (stage: string | undefined) =>
  stage !== undefined && rehearsalStage.test(stage);

/** The Alchemy stack name for a stage. Previews and production keep the original name. */
export const stackNameForStage = (stage: string | undefined) =>
  isRehearsalStage(stage) ? rehearsalStack : productionRelease.stack;

/** An unset stage is production; any stage that is neither production nor a rehearsal refuses. */
export function releaseTarget(env: NodeJS.ProcessEnv = process.env): ReleaseTarget {
  const stage = env.ALCHEMY_STAGE;
  if (stage === undefined || stage === productionRelease.stage) return productionRelease;
  if (isRehearsalStage(stage)) return { stack: rehearsalStack, stage, rehearsal: true };
  throw new BarrierRefusal("release-stage-unknown", "ALCHEMY_STAGE");
}

/** Entries that mutate refuse unless the stage was named explicitly. */
export function explicitReleaseTarget(env: NodeJS.ProcessEnv = process.env): ReleaseTarget {
  if (env.ALCHEMY_STAGE === undefined)
    throw new BarrierRefusal("release-stage-unknown", "ALCHEMY_STAGE");
  return releaseTarget(env);
}

/** Decoded records must name the stage and stack this process releases, read at decode time. */
export const ReleaseStageName = Schema.String.check(
  Schema.makeFilter((value) => value === releaseTarget().stage),
);
export const ReleaseStackName = Schema.String.check(
  Schema.makeFilter((value) => value === releaseTarget().stack),
);

export const releaseScope = () => {
  const target = releaseTarget();
  return { stack: target.stack, stage: target.stage };
};

/**
 * Rehearsal-only stop points reproduce a release that ended part way. A production process that
 * sees one refuses instead of ignoring it, so the variable can never shape a production release.
 */
export type RehearsalStop = "after-adopt";
export function rehearsalStop(env: NodeJS.ProcessEnv = process.env): RehearsalStop | undefined {
  const value = env.BASALT_REHEARSAL_STOP;
  if (value === undefined || value === "") return undefined;
  if (!releaseTarget(env).rehearsal)
    throw new BarrierRefusal("release-rehearsal-stop-on-production", "BASALT_REHEARSAL_STOP");
  if (value !== "after-adopt")
    throw new BarrierRefusal("release-rehearsal-stop-unknown", "BASALT_REHEARSAL_STOP");
  return value;
}

/** A rehearsal can shorten the old-generation drain to reproduce its deadline; production refuses. */
export function rehearsalDrainCap(env: NodeJS.ProcessEnv = process.env): number | undefined {
  const value = env.BASALT_REHEARSAL_DRAIN_CAP_MS;
  if (value === undefined || value === "") return undefined;
  if (!releaseTarget(env).rehearsal)
    throw new BarrierRefusal(
      "release-rehearsal-drain-cap-on-production",
      "BASALT_REHEARSAL_DRAIN_CAP_MS",
    );
  const milliseconds = Number(value);
  if (!/^[1-9][0-9]{3,6}$/u.test(value) || milliseconds > 30 * 60_000)
    throw new BarrierRefusal("release-rehearsal-drain-cap-invalid", "BASALT_REHEARSAL_DRAIN_CAP_MS");
  return milliseconds;
}

/** Entries validate every rehearsal control before touching State, so a bad one refuses first. */
export function releaseEntryTarget(env: NodeJS.ProcessEnv = process.env): ReleaseTarget {
  const target = explicitReleaseTarget(env);
  rehearsalStop(env);
  rehearsalDrainCap(env);
  return target;
}
