import { canonical } from "../manifest.ts";
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
import {
  RuntimeSlotStorage,
  nativeMembershipKey,
  slotSelectionKey,
} from "../../../src/pool/runtime-slots/storage.ts";
import { policyHealthHeader } from "../../../src/pool/runtime-health.ts";
import { openEnvelope } from "../../../src/pool/token.ts";

const Command = Schema.Struct({
  action: Schema.Literals(["inspect", "active-health", "fleet-inspect", "witness"]),
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

/** Production's membership shape when adopt ran: six dirty pools with no accounts and one clean. */
export function adoptedMemberships(now: number) {
  const rows = Array.from({ length: 7 }, (_, index) => {
    const clean = index === 3;
    return {
      pool: `pool-${index}`,
      organization: `organization-${index}`,
      revision: index + 1,
      expiresAt: clean ? now + 600_000 : now - 1,
      accounts: clean ? ["account-a"] : [],
      dirty: !clean,
      native: true,
    };
  });
  return Object.fromEntries(rows.map((row) => [row.pool, row]));
}

/**
 * The live controller's handoff for settlement reads. Fleet reads are knobs. Witness reads, and with
 * `realReads` set inspect and active-health too, go through the real handoff over a slot store that
 * tests may retain records and a selection in.
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
        // Only a selected runtime's health read reaches the container.
        getTcpPort: () => ({
          fetch: async (url: string) => {
            if (new URL(url).pathname !== "/ready")
              throw new Error("A settlement read never reaches the container otherwise");
            return Response.json(
              { boot_id: knobs.bootId, started_at: "baseline-started" },
              { headers: { [policyHealthHeader]: "1500" } },
            );
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
    realReads?: boolean;
    bootId: string;
    fleet: Record<string, unknown>;
    fleetResponse?: () => Response;
    firstInspect?: (live: () => Promise<Response>) => Response | Promise<Response>;
    finalInspect?: (live: () => Promise<Response>) => Response | Promise<Response>;
    activeHealth?: (live: () => Promise<Response>) => Response | Promise<Response>;
    witness?: (live: () => Promise<Response>) => Response | Promise<Response>;
  } = { bootId: "baseline-boot", fleet: { resources: [], bindings: [] } };
  return Object.assign(knobs, {
    storage,
    live,
    /** Writes a witness record through the real store, as `admit` does before adoption commits. */
    async retain(
      kind: "start" | "unattested-active",
      target: SlotTarget,
      options: {
        operationId?: string;
        selection?: { policyDigest: string; revisions: readonly unknown[] };
      } = {},
    ) {
      const configuration = runtimeConfiguration(env);
      const unattested = kind === "unattested-active";
      const authorization = Schema.decodeUnknownSync(Authorization)({
        format: runtimeAttestationFormat,
        kind,
        operationId: options.operationId ?? "adopt-retained",
        manifestDigest: "e".repeat(64),
        controllerCode: input.code,
        target,
        configurationFingerprint: await configurationDigest(configuration),
        selection: {
          expectedEpoch: 0,
          active: null,
          ...(options.selection ?? { policyDigest: "6".repeat(64), revisions: [] }),
        },
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
    /**
     * The state a committed adopt leaves: the retained unattested witness, bound to the policy
     * snapshot it saw, and the legacy root selected at epoch 1.
     */
    async adopt(target: SlotTarget, operationId: string) {
      await storage.put(nativeMembershipKey, adoptedMemberships(Date.now()));
      const snapshot = await new RuntimeSlotStorage(state).inspect();
      await this.retain("unattested-active", target, {
        operationId,
        selection: {
          policyDigest: snapshot.digest,
          revisions: [
            ...snapshot.policies.map((row) => ({ ...row, retired: false })),
            ...snapshot.denials.map((row) => ({ ...row, retired: true })),
          ]
            .map(({ pool, organization, revision, retired }) => ({
              pool,
              organization,
              revision,
              retired,
            }))
            .sort((left, right) => left.pool.localeCompare(right.pool)),
        },
      });
      const identity = { ...target, bootId: "baseline-boot" };
      await storage.put(slotSelectionKey, {
        epoch: 1,
        active: { target, identity, fenced: false },
      });
      knobs.realReads = true;
    },
    async handle(request: Request) {
      const forwarded = request.clone();
      const body = Schema.decodeUnknownSync(Schema.Struct({ envelope: Schema.String }))(
        await request.json(),
      );
      const command = Schema.decodeUnknownSync(Command, { onExcessProperty: "error" })(
        await openEnvelope(input.key, runtimeHandoffCommandPrefix, body.envelope),
      );
      input.calls.push(`POST ${command.action}`);
      // Another controller code is refused by the real handler, as production refuses it.
      if (canonical(command.controllerCode) !== canonical(input.code)) return live(forwarded);
      if (command.action === "fleet-inspect")
        return knobs.fleetResponse?.() ?? Response.json({ result: knobs.fleet });
      const real = () => live(forwarded);
      if (command.action === "witness") return knobs.witness?.(real) ?? real();
      if (command.action === "active-health") return knobs.activeHealth?.(real) ?? real();
      inspections++;
      if (inspections === 1 && knobs.firstInspect) return knobs.firstInspect(real);
      if (inspections > 1 && knobs.finalInspect) return knobs.finalInspect(real);
      if (knobs.realReads) return real();
      const selected =
        (knobs.selectionAt === "first" && inspections === 1) ||
        (knobs.selectionAt === "final" && inspections > 1);
      return Response.json({
        result: { controllerCode: input.code, ...(selected ? { selection: {} } : {}) },
      });
    },
  });
}
