import type { RehearsalStop } from "../release-barrier/release-stage.ts";
import type { ReleaseOutcome } from "./rehearsal-plan.ts";
import type { ShapePhase } from "./rehearsal-worker-shape.ts";
import { requireReadOnlyPreflight } from "./rehearsal-single-writer.ts";

/**
 * Recovery from every point a single-writer release can stop at. A stop after bootstrap or bind
 * has no abort or settlement, so the same candidate is dispatched again; a pending startup is
 * aborted and a new candidate follows; a class expansion is recovered by recorded versions.
 */
export interface RecoveryHooks {
  deployBaseline(): Promise<void>;
  shape(phase: ShapePhase, label: string, selection: boolean): Promise<void>;
  preflight(): Promise<unknown>;
  seedPools(): Promise<{ cleanPool: string }>;
  release(input: { cleanPool: string; stop?: RehearsalStop; commit?: string }): Promise<ReleaseOutcome>;
  /** The barrier's runtime abort, planned then applied by its digest; returns the final receipt. */
  abort(): Promise<{ status?: unknown }>;
  /** A new candidate commit on top of the stopped one, prepared and built. */
  nextCandidate(): Promise<string>;
  /** Recorded-version recovery with this run's own last manifest and receipt; returns its outcome. */
  recover(input: { databaseCompatible: boolean }): Promise<ReleaseOutcome>;
  serve(): Promise<unknown>;
}

export type RecoveryRecord = { scenario: "single-writer-resume" | "single-writer-rollback"; steps: string[] };

const stopped = (outcome: ReleaseOutcome, point: string) => {
  if (outcome.ok || outcome.reason !== `release-rehearsal-stopped-${point}`)
    throw new Error(`The release did not stop at ${point}: ${outcome.ok ? "it completed" : outcome.reason}`);
};

function recoverySteps(scenario: RecoveryRecord["scenario"], hooks: RecoveryHooks, smoke: (step: Step, cleanPool: string) => Promise<unknown>) {
  const record: RecoveryRecord = { scenario, steps: [] };
  const step: Step = async (name, run) => {
    await run();
    record.steps.push(name);
  };
  let cleanPool = "";
  return {
    record,
    deploy: async () => {
      await step("0-seed-plain-baseline", hooks.deployBaseline);
      await step("0-shape-untagged", () => hooks.shape("baseline", "baseline", false));
    },
    seed: async () => {
      ({ cleanPool } = await hooks.seedPools());
      record.steps.push("seed-clean-pool");
    },
    smoke: () => smoke(step, cleanPool),
  };
}
type Step = (name: string, run: () => Promise<unknown>) => Promise<void>;

export function resumeSteps(hooks: RecoveryHooks) {
  return recoverySteps("single-writer-resume", hooks, async (step, cleanPool) => {
    // A re-dispatch skips a color it already bootstrapped, so one run reaches one point per color;
    // the rollback stage covers the other ordering.
    for (const point of ["after-bootstrap-blue", "after-bind-green"] as const) {
      await step(`4-stop-${point}`, async () => stopped(await hooks.release({ cleanPool, stop: point }), point));
      // The same candidate again from here: same classes, no second application, same selection.
      await step(`4-shape-${point}`, () => hooks.shape("classes", point, true));
    }
    await step("4-stop-before-promotion-gate", async () =>
      stopped(await hooks.release({ cleanPool, stop: "before-promotion-gate" }), "before-promotion-gate"),
    );
    await step("4-abort-pending-startup", async () => {
      const receipt = await hooks.abort();
      if (receipt.status !== "aborted") throw new Error(`The runtime abort ended ${String(receipt.status)}`);
    });
    await step("4-shape-after-abort", () => hooks.shape("classes", "aborted", true));
    await step("4-same-candidate-refuses", async () => {
      const outcome = await hooks.release({ cleanPool });
      if (outcome.ok || outcome.reason !== "runtime-release-candidate-aborted-or-pending")
        throw new Error("The aborted candidate was not refused");
    });
    const next = await hooks.nextCandidate();
    await step("4-next-candidate-preflight", async () => requireAbortedPrior(await hooks.preflight()));
    await step("4-next-candidate-release", async () => {
      const outcome = await hooks.release({ cleanPool, commit: next });
      if (!outcome.ok) throw new Error(`The release after the abort refused: ${outcome.reason}`);
    });
    await step("4-shape-after-next", () => hooks.shape("classes", "next-released", false));
    return hooks.serve();
  });
}

export function rollbackSteps(hooks: RecoveryHooks) {
  return recoverySteps("single-writer-rollback", hooks, async (step, cleanPool) => {
    // After its controller phase the expanding release has committed its classes and written its pair.
    await step("4-stop-after-controller", async () => stopped(await hooks.release({ cleanPool, stop: "after-controller" }), "after-controller"));
    await step("4-shape-after-classes", () => hooks.shape("classes", "after-classes", false));
    // That pair names the pre-expansion PoolWorker: refused before any write.
    await step("4-recover-to-pre-expansion-refuses", async () => {
      const outcome = await hooks.recover({ databaseCompatible: false });
      if (outcome.ok || !/^declared-class-(?:recovery-export-missing|pre-migration-rollback-refused)$/u.test(outcome.reason))
        throw new Error(`Recovery to the pre-expansion version was not refused: ${outcome.ok ? "accepted" : outcome.reason}`);
    });
    // Cloudflare never deletes a class without a migration, and nothing sends one.
    await step("4-shape-after-refused-recovery", () => hooks.shape("classes", "after-refused-recovery", false));
    // The other bind ordering, re-dispatching the same candidate from each point.
    for (const point of ["after-bind-blue", "after-bootstrap-green"] as const) {
      await step(`4-stop-${point}`, async () => stopped(await hooks.release({ cleanPool, stop: point }), point));
      await step(`4-shape-${point}`, () => hooks.shape("classes", point, true));
    }
    await step("4-expanding-release-completes", async () => {
      const outcome = await hooks.release({ cleanPool });
      if (!outcome.ok) throw new Error(`The expanding release did not complete on re-dispatch: ${outcome.reason}`);
    });
    // The next release's own pair freezes the post-expansion PoolWorker, which carries the classes.
    const next = await hooks.nextCandidate();
    await step("4-next-stop-after-controller", async () =>
      stopped(await hooks.release({ cleanPool, stop: "after-controller", commit: next }), "after-controller"),
    );
    await step("4-recover-to-post-expansion", async () => {
      // The next candidate is an empty commit: the same tree, so the same database.
      const outcome = await hooks.recover({ databaseCompatible: true });
      if (!outcome.ok) throw new Error(`Recovery to the post-expansion version refused: ${outcome.reason}`);
    });
    await step("4-shape-after-recovery", () => hooks.shape("classes", "after-recovery", false));
    return hooks.serve();
  });
}

/** The candidate after an abort reads the aborted prior as settled, through the journal's source. */
export function requireAbortedPrior(report: unknown) {
  requireReadOnlyPreflight(report);
  const text = JSON.stringify(report ?? null);
  if (!text.includes("prior-settled-or-aborted")) throw new Error("The preflight did not read the aborted prior as settled");
  if (!text.includes("journal-source")) throw new Error("The preflight did not take its baseline from the journal");
}
