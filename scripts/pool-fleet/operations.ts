import { readFile } from "node:fs/promises";
import { Effect, Result, Schema } from "effect";
import {
  FleetConfiguration,
  type FleetApplication,
} from "../../src/pool/runtime-fleet/configuration.ts";
import { controllerAdoptionMs } from "../../src/pool/runtime-slots/forced-restart-timing.ts";
import { countStillMs, retiringBoundMs } from "../../src/pool/runtime-fleet/phase-bounds.ts";
import { providerDigest } from "../../src/pool/runtime-provider/canonical.ts";
import {
  containerApplication,
  requireBinding,
  workerPlainBindings,
  type CloudflareAccess,
} from "./cloudflare.ts";
import {
  checkRetire,
  inspectController,
  inspectFleet,
  sendFleetOperation,
  shortHash,
  type ControllerAccess,
} from "./controller.ts";
import {
  atStep,
  describeError,
  FleetLaneRefused,
  refuse,
  workerAnswer,
  type FleetStep,
} from "./errors.ts";
import { applicationPins } from "./pins.ts";

const call = <A>(work: () => Promise<A>) =>
  Effect.tryPromise({ try: work, catch: (error) => error });
export const step = <A>(name: FleetStep, work: () => Promise<A>) =>
  Effect.tryPromise({ try: work, catch: (error) => atStep(name, error) });
export const configureOperationId = (go: string) => `fleet-${shortHash("configure", go)}`;
type FleetView = Awaited<ReturnType<typeof inspectFleet>>;
type Permission = NonNullable<FleetView["permission"]>;
type Wanted = { color: "blue" | "green"; applicationId: string; imageInput: string };

/**
 * The controller's code handover window: within it a deploy's code and bindings reach it. The
 * platform resets the object onto a Worker version about 300 s after its upload, and can be a few
 * seconds late, so the window is the controller's own adoption allowance, which adds 30 s for
 * transport.
 */
export const controllerSettleMs = controllerAdoptionMs;
const settlePollMs = 10_000;
/**
 * How long the rows of a disabled fleet take to leave when no live stream holds them: a ledger
 * count no stream moves is lowered to the cell's own after `countStillMs`, a cell at 0 retires
 * within `retiringBoundMs`, and 30 s covers the upkeep passes between. A live stream holds its cell
 * for as long as it runs, which no bound covers: that cell is named in the refusal.
 */
export const staleRowsDrainMs = countStillMs + retiringBoundMs + 30_000;
// A clock that never moves still ends each wait.
const settleReads = controllerSettleMs / settlePollMs + 1;
const drainReads = staleRowsDrainMs / settlePollMs + 1;
/** How long the lane waits for a ready cell after it configures the fleet. */
export const readyCellBoundMs = 300_000;

/**
 * Configure relabels no occupied row whose application, version, image digest or input the new
 * configuration doesn't name (configuration.ts, assertOccupied). The same rule, so a row that would
 * refuse the configure is the row that drains first.
 */
const namesRow = (
  applications: readonly FleetApplication[],
  target: FleetView["resources"][number]["target"],
) =>
  applications.some(
    (app) =>
      app.applicationId === target.applicationId &&
      app.applicationVersion === target.applicationVersion &&
      app.imageDigest === target.imageDigest &&
      app.imageInput === target.imageInput,
  );
export interface LaneClock {
  sleep(ms: number): Promise<void>;
  now(): number;
}
/** One handover window shared by every read before a send, from the dispatch's first read. */
export interface Settle {
  clock: LaneClock;
  from: number;
}
export type Settled<A> = { value: A } | { lagging: FleetLaneRefused };

/** A read the controller refused as slot_identity: it runs other code than this checkout signs for. */
export const codeMismatch = (access: ControllerAccess, waited: boolean) =>
  refuse(
    "controller-code-mismatch",
    `The controller refused reads signed for candidate ${access.code.candidate}${waited ? ` for ${controllerSettleMs / 1000} s` : ""}; the live PoolWorker runs code built from another commit.`,
    "Dispatch from the main commit the last release deployed, or release main first.",
  );

/**
 * Reads the controller until it settles, within one handover window: nothing is sent before. A
 * read lost on the way, a controller still on its old code (it refuses the new code's signature as
 * slot_identity) and lagging bindings wait. A typed refusal and any other Worker answer stand at
 * once. Past the window, a lost read refuses as controller-not-ready, old code as
 * controller-code-mismatch, and lagging bindings keep their own refusal.
 */
export const untilSettled = <A, E = unknown>(
  settle: Settle,
  access: ControllerAccess,
  read: Effect.Effect<Settled<A>, E>,
) =>
  Effect.gen(function* () {
    for (let reads = 1; ; reads++) {
      const outcome = yield* Effect.result(read);
      let lagging: FleetLaneRefused;
      if (Result.isSuccess(outcome)) {
        if ("value" in outcome.success) return outcome.success.value;
        lagging = outcome.success.lagging;
      } else {
        const failure = outcome.failure;
        const answer = workerAnswer(failure);
        if (failure instanceof FleetLaneRefused || (answer && answer !== "slot_identity"))
          return yield* Effect.fail(failure);
        lagging = answer
          ? codeMismatch(access, true)
          : refuse(
              "controller-not-ready",
              `${describeError(failure)}, still after ${controllerSettleMs / 1000} s; nothing was sent.`,
              "Read the PoolWorker logs for the controller's code handover, then rerun with the same GO.",
            );
      }
      if (settle.clock.now() - settle.from >= controllerSettleMs || reads >= settleReads)
        return yield* Effect.fail(lagging);
      yield* Effect.promise(() => settle.clock.sleep(settlePollMs));
    }
  });

/** A read repeated while it refuses only for an application rollout, within one handover window. */
const untilRolledOut = <A>(clock: LaneClock, read: Effect.Effect<A, FleetLaneRefused>) =>
  Effect.gen(function* () {
    const from = clock.now();
    for (let reads = 1; ; reads++) {
      const outcome = yield* Effect.result(read);
      if (Result.isSuccess(outcome)) return outcome.success;
      const failure = outcome.failure;
      if (
        failure.reason !== "application-rollout-active" ||
        clock.now() - from >= controllerSettleMs ||
        reads >= settleReads
      )
        return yield* failure;
      yield* Effect.promise(() => clock.sleep(settlePollMs));
    }
  });

/** A read's failure as the lane's own refusal, keeping one the lane already typed. */
export const asLaneRefusal = (error: unknown) =>
  error instanceof FleetLaneRefused
    ? error
    : refuse(
        "fleet-read-failed",
        `${describeError(error)}.`,
        "Read the fleet with the Pool fleet workflow's inspect mode.",
      );

/** The fleet's permission and standing once the controller answers this checkout's code. */
export const fleetStanding = (settle: Settle, access: ControllerAccess) =>
  untilSettled(
    settle,
    access,
    step("inspect", () => inspectFleet(access)).pipe(Effect.map((value) => ({ value }))),
  ).pipe(
    Effect.mapError(asLaneRefusal),
    Effect.map((view) => ({
      enabled: view.permission?.enabled ?? null,
      inForce: view.inForce ?? null,
      notInForce: view.notInForce ?? null,
      rows: view.resources.length,
    })),
  );

/** The selected primary every fleet configuration names as legacy; refuses mid-handoff states. */
export const selectedPrimary = (access: ControllerAccess) =>
  Effect.gen(function* () {
    const view = yield* call(() => inspectController(access));
    const selection = view.selection;
    if (!selection?.active.identity || selection.candidate || selection.draining)
      return yield* Effect.fail(
        refuse(
          "selection-not-steady",
          `Controller selection is ${selection ? "mid-handoff (candidate or draining set) or has no identity" : "absent"}; configure needs one steady selected primary.`,
          selection ? "Let the handoff finish, then rerun." : "Adopt the root first.",
        ),
      );
    return selection.active.identity;
  });

/**
 * Builds the configuration as scripts/release-barrier/runtime-release-fleet.ts:20-51 does, but pins
 * each colour from a live read of its application, then sends one signed fleet-configure.
 */
export const configureFleet = (input: {
  cloudflare: CloudflareAccess;
  controller: ControllerAccess;
  go: string;
  active?: "blue" | "green";
  /** The growth target for this configuration; otherwise the current one, or 25. */
  targetActive?: number;
  settle: Settle;
  /** Right before the send: from here on a failure may leave the fleet configured by this run. */
  sending?: () => void;
  /**
   * A release's re-commit: only a fleet that is on gets its permission renewed. One an operator
   * turned off, or never configured, stays as it is, and nothing is sent.
   */
  enabledOnly?: boolean;
}) =>
  Effect.gen(function* () {
    const { controller: access, go } = input;
    const operationId = configureOperationId(go);
    let wanted: Wanted[] | undefined;
    const settled = yield* untilSettled<
      | { retained: Permission }
      | { off: "fleet-disabled" | "fleet-absent" }
      | {
          legacy: Effect.Success<ReturnType<typeof selectedPrimary>>;
          view: FleetView;
          wanted: Wanted[];
        }
    >(
      input.settle,
      access,
      Effect.gen(function* () {
        const retained = (yield* step("inspect", () => inspectFleet(access, operationId)))
          .permission;
        if (retained) return { value: { retained } };
        const view = yield* step("inspect", () => inspectFleet(access));
        if (input.enabledOnly && !view.permission?.enabled)
          return { value: { off: view.permission ? "fleet-disabled" : "fleet-absent" } } as const;
        const legacy = yield* selectedPrimary(access).pipe(
          Effect.mapError((error) => atStep("primary_read", error)),
        );
        if (!wanted) {
          // Its failures are typed refusals already, which stand at once.
          const bindings = yield* workerPlainBindings(input.cloudflare, access.worker);
          const read: Wanted[] = [];
          for (const color of ["blue", "green"] as const) {
            const upper = color.toUpperCase();
            read.push({
              color,
              applicationId: yield* requireBinding(bindings, `POOL_${upper}_APPLICATION_ID`),
              imageInput: yield* requireBinding(bindings, `POOL_${upper}_IMAGE_HASH`),
            });
          }
          wanted = read;
        }
        // The controller compares against its own bindings, not the API's; both must agree.
        const lagging = wanted.find(
          (want) =>
            !view.bindings.some(
              (binding) =>
                binding.color === want.color &&
                binding.applicationId === want.applicationId &&
                binding.imageInput === want.imageInput,
            ),
        );
        if (lagging) {
          const upper = lagging.color.toUpperCase();
          return {
            lagging: refuse(
              "controller-bindings-differ",
              `fleet-inspect bindings still lack ${lagging.color} with the settings' POOL_${upper}_APPLICATION_ID and POOL_${upper}_IMAGE_HASH after ${controllerSettleMs / 1000} s (controller lists ${view.bindings.length} bindings).`,
              "Read the PoolWorker deploy: the controller never took the settings' bindings.",
            ),
          };
        }
        return { value: { legacy, view, wanted } };
      }),
    );
    if ("retained" in settled)
      return {
        status: "already-configured" as const,
        operationId,
        digest: settled.retained.digest,
      };
    if ("off" in settled) return { status: settled.off, operationId };
    const { legacy } = settled;
    let { view } = settled;
    // The pins this configure commits, read live. Right after a release Cloudflare may still roll
    // an application it updated, and the controller refuses to observe one that rolls: wait for it
    // within one handover window, before anything is sent.
    const readPins = Effect.gen(function* () {
      const read: FleetApplication[] = [];
      for (const { color, applicationId, imageInput } of settled.wanted) {
        const raw = yield* containerApplication(input.cloudflare, applicationId);
        read.push(yield* applicationPins(color, applicationId, imageInput, raw));
      }
      return read;
    });
    const applications = yield* untilRolledOut(input.settle.clock, readPins);
    // After a release rebuilt the cells, the cells it started before still hold rows the new
    // configuration doesn't name, and configure refuses to relabel them: drain them first.
    const stale = view.resources.filter((row) => !namesRow(applications, row.target));
    // A release never turns on a fleet someone turned off: each send is preceded by a read, and a
    // fleet disabled by anyone but this run's own drain stops it with nothing more sent.
    let drained: string | undefined;
    if (stale.length) {
      if (input.enabledOnly) {
        const now = (yield* step("inspect", () => inspectFleet(access))).permission;
        if (!now?.enabled) return { status: "fleet-disabled" as const, operationId, during: true };
      }
      input.sending?.();
      const disabled = yield* disableFleet(access, go);
      if (input.enabledOnly && disabled.status === "already-disabled")
        return { status: "fleet-disabled" as const, operationId, during: true };
      drained = disabled.operationId;
      const from = input.settle.clock.now();
      for (let reads = 1; ; reads++) {
        view = yield* step("inspect", () => inspectFleet(access));
        // Done once every row left is one the new configuration names, a quarantined one included.
        if (view.resources.every((row) => namesRow(applications, row.target))) break;
        if (input.settle.clock.now() - from >= staleRowsDrainMs || reads >= drainReads) {
          const rows = view.resources
            .map(
              (row) =>
                `${shortHash(row.target.slotId)} ${row.phase} with ${row.active} streams counted`,
            )
            .join(", ");
          return yield* refuse(
            "stale-rows-remain",
            `${view.resources.length} rows still occupy the fleet ${staleRowsDrainMs / 1000} s after disabling it to drain the ${stale.length} cells of the image before: ${rows}.`,
            "A row that still counts streams holds a live one, and leaves when it ends. The fleet stays disabled and the root serves; once fleet-inspect shows no rows, run the fleet lane's configure-and-accept with a new GO.",
          );
        }
        yield* Effect.promise(() => input.settle.clock.sleep(settlePollMs));
      }
    }
    const current = view.permission ?? undefined;
    const configuration = yield* Effect.try({
      try: () =>
        Schema.decodeUnknownSync(FleetConfiguration, { onExcessProperty: "error" })({
          format: "pool-runtime-fleet-v1",
          controllerCode: access.code,
          controllerId: legacy.controllerId,
          legacy,
          revision: (current?.configuration.revision ?? 0) + 1,
          previousDigest: current?.digest ?? null,
          active:
            input.active ??
            applications.find((app) => app.applicationId === legacy.applicationId)?.color ??
            current?.configuration.active ??
            "blue",
          applications,
          maximum: current?.configuration.maximum ?? 4,
          targetActive: input.targetActive ?? current?.configuration.targetActive ?? 25,
          idleMilliseconds: current?.configuration.idleMilliseconds ?? 60_000,
        }),
      catch: () =>
        refuse(
          "configuration-invalid",
          "The built FleetConfiguration fails src/pool/runtime-fleet/configuration.ts:27-39.",
          "Read the pins in the output; one of them is outside the schema.",
        ),
    });
    if (input.enabledOnly) {
      const now = (yield* step("inspect", () => inspectFleet(access))).permission;
      if (!now?.enabled && !(drained && now?.operationId === drained))
        return { status: "fleet-disabled" as const, operationId, during: true };
    }
    input.sending?.();
    const sent = yield* step("send", () =>
      sendFleetOperation(
        access,
        {
          controllerCode: access.code,
          action: "fleet-configure",
          operationId,
          configuration,
        },
        go,
      ),
    );
    const after = (yield* step("inspect_after", () => inspectFleet(access, operationId)))
      .permission;
    const digest = yield* step("digest", () => providerDigest(configuration));
    if (!after?.enabled || after.digest !== digest)
      return yield* Effect.fail(
        refuse(
          "configure-not-retained",
          `fleet-inspect(${operationId}) shows enabled=${after?.enabled ?? "absent"}, digest ${after?.digest === digest ? "equal" : "different"} after the send.`,
          "Inspect again; never resend with a new GO before reading what the controller holds.",
        ),
      );
    return { status: sent.status, operationId, digest, configuration };
  });

const RetireReceipt = Schema.Struct({
  key: Schema.String,
  ordinal: Schema.NullOr(Schema.Number),
  ledger: Schema.Number,
  cell: Schema.Number,
  ledgerStillMs: Schema.Number,
  cellStillMs: Schema.Number,
  ledgerLowered: Schema.Boolean,
  connections: Schema.NullOr(Schema.Number),
  unstamped: Schema.Number,
  foreignSockets: Schema.Number,
});
/**
 * Whose leases a cell's count holds, by #1871's stamps: this object instance's own (live as far as
 * anyone knows), sockets other instances took (a model socket outlives its instance), unstamped ones
 * from before the stamps, and any count with no lease record at all.
 */
const leaseOwnerLine = (
  count: number,
  leases: {
    currentCalls: number;
    currentSockets: number;
    foreignSockets: number;
    unstamped: number;
  },
) => {
  const current = leases.currentCalls + leases.currentSockets;
  const unrecorded = count - current - leases.foreignSockets - leases.unstamped;
  if (current > 0)
    return `${current} of the cell's leases belong to its current instance (${leases.currentCalls} calls, ${leases.currentSockets} model sockets), so their streams may be live; the override refuses them`;
  const proven = [
    leases.foreignSockets
      ? `${leases.foreignSockets} model sockets another instance took, which can outlive it`
      : "",
    leases.unstamped ? `${leases.unstamped} unstamped leases from before the stamps` : "",
  ].filter(Boolean);
  // The proof release ends lease records only; a count with none ends only by the override.
  const parts = [
    proven.length
      ? `${proven.join(", ")}, which the proof release ends only when 8317 reads 0`
      : "",
    unrecorded > 0
      ? `${unrecorded} counted with no lease record, which only the override ends`
      : "",
  ].filter(Boolean);
  return parts.length
    ? `none of the cell's leases is held by its current instance: ${parts.join("; ")}`
    : "the cell holds no lease";
};

/**
 * The check before retire-row: the controller's refusal tests and the cell's own check and 8317
 * read for the named row, with nothing overridden. Any go text will do, as for inspect.
 */
export const checkRetireRow = (access: ControllerAccess, key: string) =>
  Effect.gen(function* () {
    if (!/^[0-9a-f]{8,24}$/u.test(key))
      return yield* Effect.fail(
        refuse(
          "row-key-invalid",
          "key must be 8 to 24 lowercase hex digits, a row's key from the lane's inspect.",
          "Pass the row's key as the key input.",
        ),
      );
    const checked = yield* call(() => checkRetire(access, key));
    const leases = checked.leases;
    return {
      ...checked,
      // Whose leases the cell's count holds, by #1871's stamps and kinds.
      leaseOwner: !leases
        ? "the cell's leases weren't read"
        : leaseOwnerLine(checked.cell ?? 0, leases),
    };
  });

export const retireOperationId = (go: string, key: string) =>
  `fleet-${shortHash("retire", go, key)}`;

/**
 * Retires one named draining row over a count that stood still. The lane refuses what it can see
 * first; the controller checks every rule again (src/pool/runtime-fleet/controller.ts, retireRow).
 */
export const retireRow = (access: ControllerAccess, go: string, key: string) =>
  Effect.gen(function* () {
    if (!/^[0-9a-f]{8,24}$/u.test(key))
      return yield* Effect.fail(
        refuse(
          "row-key-invalid",
          "key must be 8 to 24 lowercase hex digits, a row's key from the lane's inspect.",
          "Pass the row's key as the key input.",
        ),
      );
    const named = (fleet: Awaited<ReturnType<typeof inspectFleet>>) =>
      fleet.resources.filter((row) => shortHash(row.target.slotId).startsWith(key));
    const rows = named(yield* call(() => inspectFleet(access)));
    const row = rows[0];
    if (rows.length !== 1 || !row)
      return yield* Effect.fail(
        refuse(
          "row-key-ambiguous",
          `key ${key} matches ${rows.length} fleet rows; it must match exactly one.`,
          "Pass a longer key from the lane's inspect.",
        ),
      );
    if (row.phase !== "draining")
      return yield* Effect.fail(
        refuse(
          "row-not-draining",
          `row ${key} is ${row.phase}; only a draining row may be retired over its count.`,
          "Disable the fleet or let the row idle out, then rerun once its count has stood still 300 s.",
        ),
      );
    const operationId = retireOperationId(go, key);
    const sent = yield* call(() =>
      sendFleetOperation(
        access,
        { controllerCode: access.code, action: "fleet-retire", operationId, go, key },
        go,
      ),
    );
    // The controller's receipt names what it overrode; only closed numbers and the key leave.
    const receipt = yield* call(async () =>
      Schema.decodeUnknownOption(
        Schema.Struct({ result: Schema.Struct({ result: RetireReceipt }) }),
      )(JSON.parse(await readFile(sent.receiptPath, "utf8"))),
    );
    return {
      operationId,
      status: sent.status,
      overrode: receipt._tag === "Some" ? receipt.value.result.result : null,
    };
  });

/** fleet-disable needs its own operation id: reusing the configure id is refused (configuration.ts:221-224). */
export const disableFleet = (access: ControllerAccess, go: string) =>
  Effect.gen(function* () {
    const current = (yield* step("inspect", () => inspectFleet(access))).permission;
    if (!current)
      return yield* Effect.fail(
        refuse(
          "fleet-record-missing",
          "fleet-inspect has no permission record, so there is nothing to disable.",
          "None needed: the pool already runs on the root alone.",
        ),
      );
    if (!current.enabled)
      return { status: "already-disabled" as const, operationId: current.operationId };
    const operationId = `disable-${shortHash("disable", go, current.digest)}`;
    yield* step("send", () =>
      sendFleetOperation(
        access,
        {
          controllerCode: access.code,
          action: "fleet-disable",
          operationId,
          expectedDigest: current.digest,
        },
        go,
      ),
    );
    const after = (yield* step("inspect_after", () => inspectFleet(access))).permission;
    if (after?.enabled !== false)
      return yield* Effect.fail(
        refuse(
          "disable-not-retained",
          `fleet-inspect shows enabled=${after?.enabled ?? "absent"} after fleet-disable ${operationId}.`,
          "Dispatch mode disable with the same GO; it reads before it sends.",
        ),
      );
    return { status: "disabled" as const, operationId };
  });

/** Cells start on demand, so each poll also sends one cheap request to keep demand recent. */
export const waitForReadyCell = (input: {
  controller: ControllerAccess;
  demand: () => Promise<unknown>;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
  boundMs?: number;
}) =>
  Effect.gen(function* () {
    const started = input.now();
    const primary = yield* selectedPrimary(input.controller);
    while (true) {
      const fleet = yield* call(() => inspectFleet(input.controller));
      const ready = fleet.resources.find(
        (row) =>
          row.phase === "ready" && row.identity && row.target.instanceId !== primary.instanceId,
      );
      if (ready) return { identity: ready.identity!, waitedMs: input.now() - started };
      if (fleet.permission?.enabled !== true)
        return yield* Effect.fail(
          refuse(
            "fleet-not-enabled",
            `fleet-inspect shows enabled=${fleet.permission?.enabled ?? "absent"}; no cell can start.`,
            "Configure the fleet with a new coordinator GO.",
          ),
        );
      if (input.now() - started >= (input.boundMs ?? readyCellBoundMs))
        return yield* Effect.fail(
          refuse(
            "ready-cell-timeout",
            `No ready fleet cell within ${Math.round((input.boundMs ?? readyCellBoundMs) / 1000)} s; rows: ${fleet.resources.map((row) => row.phase).join(",") || "none"}.`,
            "Read the PoolWorker logs for POOL_FLEET_* and the container application's instances.",
          ),
        );
      yield* call(() => input.demand().catch(() => undefined));
      yield* call(() => input.sleep(10_000));
    }
  });
