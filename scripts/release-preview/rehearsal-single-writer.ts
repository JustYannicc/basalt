import type { ReleaseOutcome, ReleaseRequest } from "./rehearsal-plan.ts";
import type { ShapePhase } from "./rehearsal-worker-shape.ts";

/**
 * One class path change rehearsed from production's PoolWorker shape. The baseline deploys the way
 * production's PoolWorker was made, the candidate's release adds the fleet classes and binds both
 * applications, and two later plain deploys must leave every class namespace where it was.
 */
export interface SingleWriterHooks {
  deployBaseline(): Promise<void>;
  /** Reads PoolWorker back and refuses unless it has the shape this phase expects. */
  shape(phase: ShapePhase, label: string): Promise<void>;
  /** The candidate's read-only release preflight against the seeded stage; returns its report. */
  preflight(): Promise<unknown>;
  seedPools(): Promise<{ cleanPool: string }>;
  release(request: ReleaseRequest): Promise<ReleaseOutcome>;
  /** A plain alchemy deploy of the candidate, with one PoolWorker variable flipped when asked. */
  redeploy(change: boolean): Promise<void>;
  serve(): Promise<unknown>;
}

export type SingleWriterRecord = { scenario: "single-writer"; steps: string[]; release?: ReleaseOutcome };

export function singleWriterSteps(hooks: SingleWriterHooks) {
  const record: SingleWriterRecord = { scenario: "single-writer", steps: [] };
  const step = async (name: string, run: () => Promise<unknown>) => {
    await run();
    record.steps.push(name);
  };
  let cleanPool = "";
  return {
    record,
    deploy: async () => {
      await step("0-seed-plain-baseline", hooks.deployBaseline);
      await step("0-shape-untagged", () => hooks.shape("baseline", "baseline"));
      await step("0-preflight-runtime-bootstrap", async () => requireRuntimeBootstrap(await hooks.preflight()));
    },
    seed: async () => {
      ({ cleanPool } = await hooks.seedPools());
      record.steps.push("seed-clean-pool");
    },
    smoke: async () => {
      await step("1-2-candidate-release", async () => {
        const outcome = await hooks.release({ candidate: "candidate", cleanPool });
        record.release = outcome;
        if (!outcome.ok) throw new Error(`The single-writer release refused: ${outcome.reason}`);
      });
      await step("1-2-shape-classes", () => hooks.shape("classes", "released"));
      await step("3-plain-redeploy", () => hooks.redeploy(false));
      await step("3-shape-unchanged", () => hooks.shape("classes", "redeployed"));
      await step("3-plain-redeploy-changed-env", () => hooks.redeploy(true));
      await step("3-shape-unchanged-after-env", () => hooks.shape("classes", "redeployed-env"));
      return hooks.serve();
    },
  };
}

/** The preflight must see both fleet classes declared for alchemy's untagged class step. */
export function requireRuntimeBootstrap(report: unknown) {
  const steps = (report as { steps?: unknown } | null)?.steps;
  const step = Array.isArray(steps)
    ? (steps as { step?: unknown; status?: unknown; summary?: unknown }[]).find((entry) => entry.step === "runtime-bootstrap")
    : undefined;
  const summary = JSON.stringify(step?.summary ?? null);
  if (step?.status !== "pass") throw new Error("The release preflight's runtime-bootstrap step did not pass");
  if (!summary.includes('"migrationTag":"untagged"'))
    throw new Error("The release preflight did not read PoolWorker as untagged");
  for (const color of ["blue", "green"])
    if (!new RegExp(`"${color}":"declared"`).test(summary))
      throw new Error(`The release preflight did not see ${color} declared`);
}
