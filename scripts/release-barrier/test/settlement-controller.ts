import assert from "node:assert/strict";
import { Schema } from "effect";
import { SlotMemory } from "../../pool-tests/runtime-slot-storage.ts";
import { ControllerCode, type SlotTarget } from "../../../src/pool/runtime-slots/contract.ts";
import {
  LaunchAuthorization,
  UnattestedActive,
  runtimeAttestationFormat,
} from "../../../src/pool/runtime-slots/admission-proof.ts";
import {
  configurationDigest,
  runtimeConfiguration,
} from "../../../src/pool/runtime-slots/configuration.ts";
import { runtimeHandoffCommandPrefix } from "../../../src/pool/runtime-slots/handoff-command.ts";
import { RuntimeHandoff } from "../../../src/pool/runtime-slots/integration.ts";
import { handleRuntimeHandoff } from "../../../src/pool/runtime-slots/http.ts";
import { RuntimeWitnessStore } from "../../../src/pool/runtime-slots/witness-store.ts";
import { openEnvelope } from "../../../src/pool/token.ts";

const Command = Schema.Struct({
  action: Schema.Literals(["inspect", "fleet-inspect", "witness"]),
  controllerCode: ControllerCode,
  target: Schema.optional(Schema.Unknown),
  at: Schema.Number,
  expiresAt: Schema.Number,
});
const Authorization = Schema.Union([LaunchAuthorization, UnattestedActive]);

/** The controller the image journal froze before the source candidate activated its own. */
export const previousController = (accountId: string, imageHash: string) => ({
  code: { candidate: "0".repeat(40), workerInput: "9".repeat(64) },
  target: { worker: "PoolWorker", accountId },
  imageHash,
  versions: [{ versionId: "old-PoolWorker", percentage: 100 }],
  workerDigest: "8".repeat(64),
  readinessDigest: "7".repeat(64),
});

/** A finished controller phase: every Worker accepted and activated, the container unchanged. */
export function activatedReceipt(workers: readonly string[], containerVersion: number) {
  const accepted = workers.map((worker) => ({ worker, versionId: `accepted-${worker}` }));
  return {
    phase: "complete",
    accepted: accepted.map((row) => ({ ...row, startupTimeMs: 125 })),
    startupMeasurements: accepted.map((row) => ({ ...row, startupTimeMs: 125 })),
    activated: accepted,
    containers: [{ container: "PoolContainer", version: containerVersion, unchanged: true }],
  };
}

/**
 * The live controller's handoff for settlement reads. Inspect and fleet reads are knobs; the
 * witness read goes through the real handoff over a slot store that tests may retain records in.
 */
export function settlementController(input: {
  controllerId: string;
  applicationId: string;
  imageInput: string;
  code: typeof ControllerCode.Type;
  key: string;
  calls: string[];
}) {
  const storage = new SlotMemory();
  const state = {
    get: storage.get.bind(storage),
    put: storage.put.bind(storage),
    transaction: storage.transaction.bind(storage),
    getAlarm: async () => null,
    setAlarm: async () => {},
  };
  const env = {
    POOL_DATABASE_URL: "postgres://synthetic.invalid/pool",
    POOL_MANAGEMENT_KEY: "synthetic",
    POOL_APP_SIGNING_KEY: input.key,
    POOL_IMAGE_HASH: input.imageInput,
    POOL_DEPLOYMENT_KEY: input.key,
    POOL_CONTAINER_APPLICATION_ID: input.applicationId,
  };
  const handoff = new RuntimeHandoff(
    {
      id: { toString: () => input.controllerId },
      storage: state,
      container: {
        running: true,
        start: () => {},
        destroy: async () => {},
        monitor: async () => {},
        setInactivityTimeout: async () => {},
        getTcpPort: () => ({
          fetch: async () => {
            throw new Error("A witness read never reaches the container");
          },
        }),
      },
      waitUntil: () => {},
    },
    env,
    input.code,
    { wrap: (response) => response },
  );
  let inspections = 0;
  const live = (request: Request) => handleRuntimeHandoff(request, handoff, input.code, input.key);
  const knobs: {
    selectionAt?: "first" | "final";
    fleet: Record<string, unknown>;
    fleetResponse?: () => Response;
    finalInspect?: () => Response;
    witness?: () => Response;
  } = { fleet: { resources: [], bindings: [] } };
  return Object.assign(knobs, {
    storage,
    live,
    /** Writes a witness record through the real store, as `admit` does before adoption commits. */
    async retain(kind: "start" | "unattested-active", target: SlotTarget) {
      const configuration = runtimeConfiguration(env);
      const unattested = kind === "unattested-active";
      const authorization = Schema.decodeUnknownSync(Authorization)({
        format: runtimeAttestationFormat,
        kind,
        operationId: "adopt-retained",
        manifestDigest: "e".repeat(64),
        controllerCode: input.code,
        target,
        configurationFingerprint: await configurationDigest(configuration),
        selection: { expectedEpoch: 0, active: null, policyDigest: "6".repeat(64), revisions: [] },
        provider: {
          accountId: "1".repeat(32),
          namespaceId: "namespace",
          applicationId: target.applicationId,
          applicationVersion: target.applicationVersion,
          imageDigest: target.imageDigest,
          applicationConfigDigest: "5".repeat(64),
          observationDigest: "4".repeat(64),
          observedAt: 1,
          ...(unattested ? { instanceId: target.instanceId } : {}),
        },
        ...(unattested ? { bootId: "baseline-boot" } : {}),
        at: 1,
        expiresAt: 2,
      });
      await new RuntimeWitnessStore(state, input.key).create(
        authorization,
        configuration,
        unattested ? { ...target, bootId: "baseline-boot" } : undefined,
      );
    },
    async handle(request: Request) {
      const forwarded = request.clone();
      const body = Schema.decodeUnknownSync(Schema.Struct({ envelope: Schema.String }))(
        await request.json(),
      );
      const command = Schema.decodeUnknownSync(Command, { onExcessProperty: "error" })(
        await openEnvelope(input.key, runtimeHandoffCommandPrefix, body.envelope),
      );
      assert.deepEqual(command.controllerCode, input.code);
      input.calls.push(`POST ${command.action}`);
      if (command.action === "fleet-inspect")
        return knobs.fleetResponse?.() ?? Response.json({ result: knobs.fleet });
      if (command.action === "witness") return knobs.witness?.() ?? live(forwarded);
      inspections++;
      if (inspections > 1 && knobs.finalInspect) return knobs.finalInspect();
      const selected =
        (knobs.selectionAt === "first" && inspections === 1) ||
        (knobs.selectionAt === "final" && inspections > 1);
      return Response.json({
        result: { controllerCode: input.code, ...(selected ? { selection: {} } : {}) },
      });
    },
  });
}
