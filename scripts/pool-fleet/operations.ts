import { readFile } from "node:fs/promises";
import { Effect, Schema } from "effect";
import {
  FleetConfiguration,
  type FleetApplication,
} from "../../src/pool/runtime-fleet/configuration.ts";
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
import { refuse } from "./errors.ts";
import { applicationPins } from "./pins.ts";

const call = <A>(work: () => Promise<A>) =>
  Effect.tryPromise({ try: work, catch: (error) => error });
export const configureOperationId = (go: string) => `fleet-${shortHash("configure", go)}`;

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
}) =>
  Effect.gen(function* () {
    const { controller: access, go } = input;
    const operationId = configureOperationId(go);
    const retained = (yield* call(() => inspectFleet(access, operationId))).permission;
    if (retained)
      return { status: "already-configured" as const, operationId, digest: retained.digest };
    const legacy = yield* selectedPrimary(access);
    const view = yield* call(() => inspectFleet(access));
    const current = view.permission ?? undefined;
    const bindings = yield* workerPlainBindings(input.cloudflare, access.worker);
    const applications: FleetApplication[] = [];
    for (const color of ["blue", "green"] as const) {
      const upper = color.toUpperCase();
      const applicationId = yield* requireBinding(bindings, `POOL_${upper}_APPLICATION_ID`);
      const imageInput = yield* requireBinding(bindings, `POOL_${upper}_IMAGE_HASH`);
      // The controller compares against its own bindings, not the API's; both must agree.
      if (
        !view.bindings.some(
          (binding) =>
            binding.color === color &&
            binding.applicationId === applicationId &&
            binding.imageInput === imageInput,
        )
      )
        return yield* Effect.fail(
          refuse(
            "controller-bindings-differ",
            `fleet-inspect bindings lack ${color} with the settings' POOL_${upper}_APPLICATION_ID and POOL_${upper}_IMAGE_HASH (controller lists ${view.bindings.length} bindings).`,
            "Wait for the PoolWorker deploy to reach the controller (up to 300 s), then rerun.",
          ),
        );
      const raw = yield* containerApplication(input.cloudflare, applicationId);
      applications.push(yield* applicationPins(color, applicationId, imageInput, raw));
    }
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
    const sent = yield* call(() =>
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
    const after = (yield* call(() => inspectFleet(access, operationId))).permission;
    const digest = yield* call(() => providerDigest(configuration));
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
  const parts = [
    leases.foreignSockets
      ? `${leases.foreignSockets} model sockets another instance took, which can outlive it`
      : "",
    leases.unstamped ? `${leases.unstamped} unstamped leases from before the stamps` : "",
    unrecorded > 0 ? `${unrecorded} counted with no lease record` : "",
  ].filter(Boolean);
  return parts.length
    ? `none of the cell's leases is held by its current instance: ${parts.join(", ")}; the proof release ends these only when 8317 reads 0`
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
      // Whose isolate took the row's cell leases: a gone one's may only be a model socket.
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
    const current = (yield* call(() => inspectFleet(access))).permission;
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
    yield* call(() =>
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
    const after = (yield* call(() => inspectFleet(access))).permission;
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
      if (input.now() - started >= (input.boundMs ?? 300_000))
        return yield* Effect.fail(
          refuse(
            "ready-cell-timeout",
            `No ready fleet cell within ${Math.round((input.boundMs ?? 300_000) / 1000)} s; rows: ${fleet.resources.map((row) => row.phase).join(",") || "none"}.`,
            "Read the PoolWorker logs for POOL_FLEET_* and the container application's instances.",
          ),
        );
      yield* call(() => input.demand().catch(() => undefined));
      yield* call(() => input.sleep(10_000));
    }
  });
