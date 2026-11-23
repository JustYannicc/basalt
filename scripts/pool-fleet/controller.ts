import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Schema } from "effect";
import { productionOpsRelease } from "../../.upstream/apps/hosted/cloud/src/implementation/production-ops-release.ts";
import { poolWorkerRevision } from "../../.upstream/apps/hosted/server/src/implementation/pool-worker-revision.ts";
import { FleetConfiguration } from "../../src/pool/runtime-fleet/configuration.ts";
import { currentCrashCommand } from "../../src/pool/runtime-crash-contract.ts";
import {
  SlotIdentity,
  SlotTarget,
  type ControllerCode,
} from "../../src/pool/runtime-slots/contract.ts";
import {
  decodeRuntimeHandoffCommand,
  type RuntimeFleetOperationPayload,
} from "../../src/pool/runtime-slots/handoff-command.ts";
import type { PoolOperationsTarget } from "../pool-operations.ts";
import { runFleetOperator } from "./fleet-operator.ts";
import { sendRuntimeCommand } from "./runtime-command-rpc.ts";
import {
  freezeRuntimeFleetOperation,
  runtimeFleetOperationDigest,
} from "./runtime-fleet-operation.ts";
import { runtimeBridgeKeyDigest } from "./runtime-slot-manifest.ts";

/** The code this checkout builds; the controller refuses every command signed for other code. */
export const checkoutControllerCode: ControllerCode = {
  candidate: productionOpsRelease,
  workerInput: poolWorkerRevision,
};

export interface ControllerAccess {
  accountId: string;
  worker: string;
  signingKey: string;
  code: ControllerCode;
  connect?: PoolOperationsTarget["connect"];
  now?: () => number;
  /** Private runner directory for operator packets and their submission markers. */
  directory: string;
}

const Selection = Schema.Struct({
  epoch: Schema.Number,
  active: Schema.Struct({ target: SlotTarget, identity: Schema.optional(SlotIdentity) }),
  candidate: Schema.optional(Schema.Unknown),
  draining: Schema.optional(Schema.Unknown),
});
const Inspect = Schema.Struct({
  result: Schema.Struct({
    selection: Schema.optional(Selection),
    digest: Schema.String,
    alertDelivery: Schema.optional(
      Schema.NullOr(
        Schema.Struct({ refusedSince: Schema.Number, lastStatus: Schema.optional(Schema.Number) }),
      ),
    ),
    lastEnd: Schema.optional(Schema.Unknown),
  }),
});
const Row = Schema.Struct({
  target: SlotTarget,
  identity: Schema.optional(SlotIdentity),
  phase: Schema.String,
  active: Schema.Number,
  reason: Schema.optional(Schema.String),
  inPhaseMs: Schema.optional(Schema.Number),
});
export const Permission = Schema.Struct({
  operationId: Schema.String,
  digest: Schema.String,
  configuration: FleetConfiguration,
  enabled: Schema.Boolean,
});
const FleetInspect = Schema.Struct({
  result: Schema.Struct({
    permission: Schema.optional(Schema.NullOr(Permission)),
    resources: Schema.Array(Row),
    bindings: Schema.Array(
      Schema.Struct({
        color: Schema.String,
        applicationId: Schema.String,
        imageInput: Schema.String,
      }),
    ),
    recentEnds: Schema.optional(Schema.Array(Schema.Unknown)),
  }),
});
export type FleetRow = typeof Row.Type;
export type FleetView = typeof FleetInspect.Type.result;
export type ControllerView = typeof Inspect.Type.result;

// A runner clock a little ahead must not sign a command in the controller's future.
const signedNow = (access: ControllerAccess) => (access.now ?? Date.now)() - 2_000;
const target = (access: ControllerAccess): PoolOperationsTarget => ({
  accountId: access.accountId,
  worker: access.worker,
  connect: access.connect,
});
export const shortHash = (...parts: string[]) =>
  createHash("sha256").update(parts.join("\n")).digest("hex").slice(0, 24);

async function read(access: ControllerAccess, action: Record<string, unknown>) {
  const at = signedNow(access);
  const command = decodeRuntimeHandoffCommand(
    { ...action, controllerCode: access.code, at, expiresAt: at + 25_000 },
    at,
  );
  return sendRuntimeCommand(command, access.signingKey, target(access), () => {
    decodeRuntimeHandoffCommand(command, signedNow(access));
  });
}

// Lenient: a newer controller may add fields; only the ones decoded here decide anything.
export const inspectController = async (access: ControllerAccess) =>
  Schema.decodeUnknownSync(Inspect)(await read(access, { action: "inspect" })).result;

export const inspectFleet = async (access: ControllerAccess, operationId?: string) =>
  Schema.decodeUnknownSync(FleetInspect)(
    await read(access, { action: "fleet-inspect", ...(operationId ? { operationId } : {}) }),
  ).result;

/**
 * One reviewed operator packet per GO. The local marker makes a repeat in the same run inspect
 * only; the controller's durable operation key does the same across runs.
 */
export async function sendFleetOperation(
  access: ControllerAccess,
  command: RuntimeFleetOperationPayload,
  coordinatorGo: string,
) {
  const operation = freezeRuntimeFleetOperation({
    candidate: access.code.candidate,
    controller: { accountId: access.accountId, scriptName: access.worker },
    bridgeKeyDigest: runtimeBridgeKeyDigest(access.signingKey),
    command,
  });
  const now = access.now ?? Date.now;
  const enable = {
    coordinatorGo,
    manifest: runtimeFleetOperationDigest(operation),
    writerLease: `pool-fleet-${shortHash(coordinatorGo)}`,
    // The GO authorizes this one send for at most ten minutes.
    expiresAt: now() + 10 * 60_000,
  };
  await mkdir(access.directory, { recursive: true, mode: 0o700 });
  const packet = join(access.directory, `${command.operationId}.json`);
  await writeFile(packet, JSON.stringify({ operation, enable }), { mode: 0o600 });
  return runFleetOperator({ packet, apply: true }, access.signingKey, {
    connect: access.connect,
    now: () => signedNow(access),
  });
}

/** Hard-kills one ready fleet cell. The cell itself refuses when its Home is the elected master. */
export async function crashCell(
  access: ControllerAccess,
  identity: SlotIdentity,
  nonce: string,
  operator: string,
) {
  const at = signedNow(access);
  const command = currentCrashCommand(
    {
      controllerCode: access.code,
      action: "runtime-crash",
      kind: "cell",
      identity,
      nonce,
      operator,
      at,
      expiresAt: at + 25_000,
    },
    at,
  );
  return sendRuntimeCommand(command, access.signingKey, target(access), () => {
    currentCrashCommand(command, signedNow(access));
  });
}

export const inspectCrash = (access: ControllerAccess, identity: SlotIdentity, nonce: string) =>
  read(access, { action: "runtime-crash-inspect", identity, nonce });

// Lenient: a newer controller may add fields to the reply.
const TakenBookmark = Schema.Struct({
  result: Schema.Struct({ bookmark: Schema.String, at: Schema.String }),
});

/**
 * The controller storage's current point-in-time bookmark: the restore target if the class change
 * fails. Reading it also arms a restore to it for ten minutes, the window the class change runs in.
 */
export const takeBookmark = async (access: ControllerAccess) =>
  Schema.decodeUnknownSync(TakenBookmark)(await read(access, { action: "storage-bookmark" }))
    .result;
