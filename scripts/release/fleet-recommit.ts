import { Effect } from "effect";
import type * as AlchemyPlan from "alchemy/Plan";
import { bindingChanges } from "./binding-changes.ts";
import { poolWorkerName } from "../pool-fleet/cloudflare.ts";
import { describeError } from "../pool-fleet/errors.ts";
import {
  asLaneRefusal,
  fleetStanding,
  readyCellBoundMs,
  staleRowsDrainMs,
} from "../pool-fleet/operations.ts";
import { runPoolFleet, type DispatchDependencies } from "../pool-fleet/dispatch.ts";

/**
 * The fleet's stored permission pins each colour by these pool Worker settings, and a launch is
 * refused for identity while they differ from it (`RuntimeFleetConfiguration.assertBindings`). A
 * deploy that rebuilds the cells changes them, and only a signed `fleet-configure` commits a new
 * permission, so the deploy re-commits it, through the fleet lane, after its smoke.
 */
export const cellBindings = [
  "POOL_BLUE_APPLICATION_ID",
  "POOL_BLUE_IMAGE_HASH",
  "POOL_GREEN_APPLICATION_ID",
  "POOL_GREEN_IMAGE_HASH",
] as const;
const isCellBinding = (name: string): name is (typeof cellBindings)[number] =>
  (cellBindings as readonly string[]).includes(name);

/** The cell bindings the plan changes on the pool Worker, by name; empty when it changes none. */
export function fleetRebindRows(plan: AlchemyPlan.Plan, poolWorker: string) {
  return bindingChanges(plan)
    .filter(({ worker }) => worker === poolWorker)
    .flatMap(({ changes }) => changes.map(({ name }) => name))
    .filter(isCellBinding)
    .sort();
}

/**
 * The longest scale-out is off in a re-commit with no held stream: the old cells' drain, then a
 * new cell's start. A held stream keeps its cell draining until it ends, past this.
 */
export const scaleOutOffMinutes = Math.ceil((staleRowsDrainMs + readyCellBoundMs) / 60_000);

/** The plan's own line, so whoever reads the plan before approving it sees what the deploy does. */
export const rebindPlanLine = (rows: readonly string[]) =>
  `This release changes the cell image (${rows.join(", ")}): the deploy re-commits the fleet permission and proves a cell. Scale-out is off for about 1 to ${scaleOutOffMinutes} minutes during this release, while the old cells drain and a new one starts; the root serves alone at its cap meanwhile.`;

/** The one lane run that turns scale-out back on. */
const laneRun =
  "One run of the Pool fleet workflow brings it back: mode configure-and-accept, with a new coordinator GO, once its inspect shows no draining row.";

/**
 * The deploy's authority for the re-commit is the approved plan's digest, which covers the binding
 * rows; this is only the lane's operation key for it. Each run and attempt gets its own, because
 * the lane only inspects under a key it has used.
 */
export const releaseGo = (candidate: string, at: Date, run: string, attempt: string) =>
  `coordinator-${at.getUTCFullYear()}-release-${candidate.slice(0, 8)}-${run}-${attempt}`;

export interface ReleaseRun {
  go: string;
  ref: string;
  event: string;
}

type Standing = Effect.Success<ReturnType<typeof fleetStanding>>;
export type RecommitOutcome =
  | { status: "not-needed"; standing: Standing }
  /** No cell binding changed and the fleet could not be read after the deploy. */
  | { status: "unread"; cause: string }
  | { status: "out-of-force"; standing: Standing }
  | { status: "fleet-off"; off: "fleet-disabled" | "fleet-absent"; during?: true }
  | { status: "recommitted" | "unproven"; result: Awaited<ReturnType<typeof runPoolFleet>> }
  | {
      status: "failed";
      result?: Awaited<ReturnType<typeof runPoolFleet>>;
      cause?: string;
      /** The fleet as a read after the failure found it; absent when that read failed too. */
      after?: Standing;
      /** The lane never started, so nothing was sent; `rows` says whether the cells changed. */
      notStarted?: true;
      rows?: number;
    };

const standingOf = (deps: DispatchDependencies) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const worker = yield* poolWorkerName(deps.cloudflare).pipe(Effect.mapError(asLaneRefusal));
      return yield* fleetStanding({ clock: deps, from: deps.now() }, deps.controller(worker));
    }),
  );

/**
 * After the deploy's smoke. With cell binding rows: the lane's own configure-and-accept, which
 * waits until the controller runs the new bindings, drains the cells of the image before, pins
 * each colour from a live read of its application, waits for a ready cell and proves a cell
 * serves; a fleet that is off stays off. With none: a read that the permission is not left out of
 * force by an earlier run.
 */
export async function recommitFleet(
  rows: readonly string[],
  run: ReleaseRun,
  deps: DispatchDependencies,
): Promise<RecommitOutcome> {
  try {
    if (!rows.length) {
      const standing = await standingOf(deps).catch((error: unknown) => describeError(error));
      if (typeof standing === "string") return { status: "unread", cause: standing };
      return standing.enabled === true && standing.notInForce === "bindings"
        ? { status: "out-of-force", standing }
        : { status: "not-needed", standing };
    }
    const result = await runPoolFleet(
      { mode: "configure-and-accept", ...run, enabledOnly: true },
      deps,
    );
    const done = "result" in result ? (result.result as Record<string, unknown>) : undefined;
    const configured = done?.configure as { status?: unknown; during?: unknown } | undefined;
    const off = configured?.status;
    if (result.ok && (off === "fleet-disabled" || off === "fleet-absent"))
      return { status: "fleet-off", off, ...(configured?.during === true ? { during: true } : {}) };
    if (result.ok && (done?.fleet as { inForce?: unknown } | undefined)?.inForce === true)
      return { status: "recommitted", result };
    const skipped = "rollback" in result ? (result.rollback as { skipped?: unknown }).skipped : "";
    if (String(skipped).startsWith("quota-refused")) return { status: "unproven", result };
    return { status: "failed", result, ...(await after(deps)) };
  } catch (error) {
    return { status: "failed", cause: describeError(error), ...(await after(deps)) };
  }
}

/** What a failed re-commit left, so its last line can say whether scale-out is off. */
const after = (deps: DispatchDependencies) =>
  standingOf(deps).then(
    (standing) => ({ after: standing }),
    () => ({}),
  );

/** Where scale-out stands, from a read of the fleet; undefined when the read failed. */
export function scaleOutLine(standing: Standing | undefined) {
  return standing?.enabled === false
    ? `Scale-out is OFF: the fleet is disabled and the root serves alone at its cap. ${laneRun}`
    : standing?.enabled === true && standing.inForce === true
      ? "Scale-out is on: the fleet is enabled and in force."
      : standing?.enabled === true
        ? `Scale-out is OFF for new cells: the fleet is enabled but out of force (${standing.notInForce}). ${laneRun}`
        : standing
          ? "Scale-out is off: the fleet has never been configured."
          : `Scale-out may be OFF: the fleet could not be read. Read it with the Pool fleet workflow's inspect mode; ${laneRun}`;
}

/**
 * The deploy's line for each outcome, whether the deploy passes, and whether the line is a warning:
 * a green deploy still says so when scale-out is off.
 */
export function recommitLine(outcome: RecommitOutcome): {
  ok: boolean;
  line: string;
  warn?: true;
} {
  const why = (value: RecommitOutcome) => {
    if ("cause" in value && value.cause) return value.cause;
    const result = "result" in value ? value.result : undefined;
    return result && "cause" in result ? String(result.cause) : "no cause recorded";
  };
  switch (outcome.status) {
    case "not-needed":
      return outcome.standing.enabled === false
        ? {
            ok: true,
            warn: true,
            line: `No cell binding changed, and the fleet is disabled: scale-out is OFF, as before this deploy. ${laneRun}`,
          }
        : { ok: true, line: "No cell binding changed: the fleet's permission stands." };
    case "unread":
      return {
        ok: false,
        line: `No cell binding changed, but the fleet could not be read after the deploy (${outcome.cause}). Scale-out may be OFF: read it with the Pool fleet workflow's inspect mode. ${laneRun}`,
      };
    case "out-of-force":
      return {
        ok: false,
        line: `The fleet's permission is out of force for its bindings although this release changed none: an earlier run left it so, and no new cell can start. ${laneRun}`,
      };
    case "fleet-off":
      return {
        ok: true,
        warn: true,
        line: outcome.during
          ? "The cells were rebuilt, and the fleet was turned off while this release ran: it stays off, so scale-out is OFF, and the release sent nothing more. The fleet lane's configure-and-accept turns it on."
          : `The cells were rebuilt and the fleet is ${outcome.off === "fleet-disabled" ? "disabled" : "not configured"}: it stays so, so scale-out is OFF, and nothing was sent. The fleet lane's configure-and-accept turns it on.`,
      };
    case "recommitted":
      return {
        ok: true,
        line: "The fleet's permission is re-committed for the new cells, it is in force, and a cell served.",
      };
    case "unproven":
      return {
        ok: false,
        line: `The fleet's permission is re-committed for the new cells and stays in force, but every acceptance model was refused for funding, so no turn proved a cell serves (${why(outcome)}). Cells can start; run the fleet lane's accept mode once the acceptance pool is funded.`,
      };
    case "failed": {
      if (outcome.notStarted)
        return {
          ok: false,
          line: `The fleet step could not start (${why(outcome)}): nothing was sent. ${
            outcome.rows
              ? "This release changed the cell image, so new cells cannot start until one run of the Pool fleet workflow re-commits the fleet: mode configure-and-accept, with a new coordinator GO."
              : "The fleet stands as it was before this release."
          }`,
        };
      return {
        ok: false,
        line: `The fleet was not re-committed and proven for the new cells (${why(outcome)}). The release is live. ${scaleOutLine(outcome.after)}`,
      };
    }
  }
}

/**
 * After a deploy that died in its fleet step (a cancel, a timeout), so printed no line about
 * scale-out: one read of the fleet, and where scale-out stands. production.yml runs it.
 */
if (import.meta.main) {
  if (process.argv[2] !== "standing") throw new Error("Usage: fleet-recommit.ts standing");
  const { appendFile } = await import("node:fs/promises");
  const { dependenciesFromEnvironment } = await import("../pool-fleet/environment.ts");
  const standing = await dependenciesFromEnvironment(process.env)
    .then(standingOf)
    .catch(() => undefined);
  const line = `This deploy ended inside its fleet step. ${scaleOutLine(standing)}`;
  console.log(`::warning::${line}`);
  if (process.env.GITHUB_STEP_SUMMARY)
    await appendFile(process.env.GITHUB_STEP_SUMMARY, `${line}\n`);
}
