import type { ReleaseOutcome, ReleaseRequest } from "./rehearsal-plan.ts";
import type { ShapePhase } from "./rehearsal-worker-shape.ts";
import { baselineRoles } from "../release-barrier/baseline-probe.ts";

export type SourceEdit = { path: string; from: string; to: string };

/** One local class PoolWorker's declared class contract does not name, beside its own. */
export const undeclaredPoolClass: SourceEdit = {
  path: "src/pool/deployment.ts",
  from: "      PoolContainer: image,\n",
  to: '      PoolContainer: image,\n      RehearsalUndeclared: Cloudflare.DurableObject("RehearsalUndeclared", { className: "RehearsalUndeclared" }),\n',
};

/**
 * One class path change rehearsed from production's PoolWorker shape. The baseline deploys the way
 * production's PoolWorker was made, the candidate's release adds the fleet classes and binds both
 * applications, and two later plain deploys must leave every class namespace where it was.
 */
export interface SingleWriterHooks {
  deployBaseline(): Promise<void>;
  /** Reads PoolWorker back and refuses unless it has the shape this phase expects. */
  shape(phase: ShapePhase, label: string): Promise<void>;
  /**
   * The backup job's read-only baseline probe, from the candidate, of the stage's own Workers;
   * returns its rows. A source edit applies to the candidate for this probe only, never deployed.
   */
  baselineProbe(edit?: SourceEdit): Promise<unknown>;
  /** The candidate's read-only release preflight against the seeded stage; returns its report. */
  preflight(): Promise<unknown>;
  seedPools(): Promise<{ cleanPool: string }>;
  release(request: ReleaseRequest): Promise<ReleaseOutcome>;
  /** A plain alchemy deploy of the candidate, with one PoolWorker variable flipped when asked. */
  redeploy(change: boolean): Promise<void>;
  serve(): Promise<unknown>;
  /** A read-only plan of the candidate without its fleet bindings; returns the plan text. */
  planWithoutFleetBindings(): Promise<string>;
}

export type SingleWriterRecord = {
  scenario: "single-writer";
  steps: string[];
  release?: ReleaseOutcome;
  negativeControl?: string[];
};

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
      await step("0-baseline-probe", async () => requireBaselineProbe(await hooks.baselineProbe()));
      await step("0-baseline-probe-undeclared-class", async () =>
        requireUndeclaredClassRefused(await hooks.baselineProbe(undeclaredPoolClass)),
      );
      await step("0-preflight-runtime-bootstrap", async () =>
        requireRuntimeBootstrap(await hooks.preflight()),
      );
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
      await step("3-negative-control", async () => {
        record.negativeControl = requireDeletedFleetClasses(await hooks.planWithoutFleetBindings());
      });
      return hooks.serve();
    },
  };
}

/**
 * Release-main reads every Worker baseline before its backup, with the candidate's own settings
 * projection; one refused row stops the release there. The probe itself matches the stage's
 * declared roles to its inventory; here every row must pass, once per role, PoolWorker included.
 */
export function requireBaselineProbe(rows: unknown) {
  const list = Array.isArray(rows)
    ? (rows as { role?: unknown; ok?: unknown; reason?: unknown }[])
    : [];
  const failed = list.filter((row) => row.ok !== true);
  if (failed.length)
    throw new Error(
      `The baseline probe refused: ${failed
        .map((row) => `${String(row.role)}: ${String(row.reason)}`)
        .join("; ")
        .slice(0, 600)}`,
    );
  const roles = list.map((row) => row.role);
  const known: readonly unknown[] = baselineRoles;
  if (
    !roles.includes("PoolWorker") ||
    new Set(roles).size !== roles.length ||
    roles.some((role) => !known.includes(role))
  )
    throw new Error("The baseline probe did not read PoolWorker and each Worker role once");
}

/**
 * The negative control: the same probe, with PoolWorker declaring a class its contract does not
 * name, must refuse PoolWorker for its classes and pass every other Worker.
 */
export function requireUndeclaredClassRefused(rows: unknown) {
  const list = Array.isArray(rows)
    ? (rows as { role?: unknown; ok?: unknown; reason?: unknown }[])
    : [];
  const pool = list.filter((row) => row.role === "PoolWorker");
  if (pool.length !== 1 || pool[0]!.ok !== false)
    throw new Error("The baseline probe did not refuse an undeclared PoolWorker class");
  if (
    pool[0]!.reason !== "durable-object-class-drift" &&
    pool[0]!.reason !== "declared-class-binding-mismatch"
  )
    throw new Error(
      `The baseline probe refused the undeclared class for another reason: ${String(pool[0]!.reason)}`,
    );
  requireBaselineProbe([
    ...list.filter((row) => row.role !== "PoolWorker"),
    { role: "PoolWorker", ok: true },
  ]);
}

/**
 * The preflight's runtime-bootstrap step must plan both colors' classes through alchemy's own
 * class step (`source: "declared"`) on a PoolWorker it reads as untagged, as production is.
 */
/** A preflight that tried to write, or ended fatally, proves nothing however its steps read. */
export function requireReadOnlyPreflight(report: unknown) {
  const value = report as {
    fatal?: unknown;
    mutations?: {
      deniedStateWrites?: unknown;
      blockedHttpMutations?: unknown;
      refusedBridgeRequests?: unknown;
    };
  } | null;
  if (value?.fatal !== undefined)
    throw new Error(`The release preflight ended fatally: ${String(value.fatal)}`);
  const mutations = value?.mutations;
  if (
    !mutations ||
    mutations.deniedStateWrites !== 0 ||
    mutations.blockedHttpMutations !== 0 ||
    Object.keys((mutations.refusedBridgeRequests as object | undefined) ?? {}).length !== 0
  )
    throw new Error("The release preflight attempted a write or a refused bridge request");
}

export function requireRuntimeBootstrap(report: unknown) {
  requireReadOnlyPreflight(report);
  const steps = (report as { steps?: unknown } | null)?.steps;
  const step = Array.isArray(steps)
    ? (steps as { step?: unknown; status?: unknown; summary?: unknown }[]).find(
        (entry) => entry.step === "runtime-bootstrap",
      )
    : undefined;
  if (step?.status !== "pass")
    throw new Error("The release preflight's runtime-bootstrap step did not pass");
  const summary = step.summary as { colors?: unknown; migrationTag?: unknown } | undefined;
  if (summary?.migrationTag !== "untagged")
    throw new Error("The release preflight did not read PoolWorker as untagged");
  const colors = Array.isArray(summary.colors)
    ? (summary.colors as { color?: unknown; source?: unknown }[])
    : [];
  for (const color of ["blue", "green"])
    if (!colors.some((entry) => entry.color === color && entry.source === "declared"))
      throw new Error(
        `The release preflight did not plan ${color} through the declared class step`,
      );
}

/**
 * Dropping the fleet bindings is the hazard the binding comment guards: alchemy would delete both
 * classes its tags still name. The plan must say so; only the lines that show it are kept.
 */
export function requireDeletedFleetClasses(plan: string): string[] {
  const lines = plan
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  const deletion = (line: string) =>
    /deleted_classes|deletedClasses|\bdelet/iu.test(line) || line.startsWith("-");
  const shown = ["PoolRuntimeBlue", "PoolRuntimeGreen"].map((name) => {
    const evidence = lines.filter(
      (line) =>
        line.includes(name) &&
        (deletion(line) || lines.some((other) => /deleted_classes|deletedClasses/u.test(other))),
    );
    if (!evidence.length) throw new Error(`The negative control's plan does not delete ${name}`);
    return evidence[0]!.slice(0, 240);
  });
  return shown;
}
