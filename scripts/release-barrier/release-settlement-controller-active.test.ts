// Regression: settlement-complete-false and settlement-lagging-state-row (a complete forward head and a State row still naming the previous controller)
import assert from "node:assert/strict";
import { test } from "node:test";
import { Effect, Schema } from "effect";
import { releaseSettlementFixture } from "./test/release-settlement-fixture.ts";
import {
  controllerActiveFixture,
  planSettlement,
  type SettlementFixture,
} from "./test/settlement-plan.ts";
import { provisioningFixture } from "./test/provisioning-fixtures.ts";
import { runtimeProofFixture } from "./test/runtime-proof-fixture.ts";
import { applyReleaseSettlement } from "./release-settlement-operation.ts";
import { releaseSettlementDigest, releaseSettlementKey } from "./release-settlement-contract.ts";
import { openReleaseSettlement } from "./release-settlement-archive.ts";
import { runtimeReleaseJournal, type RuntimeReleaseRecord } from "./runtime-release-journal.ts";
import { journalKey, writeForwardJournal } from "./forward-journal.ts";
import type { ForwardPacket } from "./forward-model.ts";
import { resumeForwardRelease } from "./forward-resume.ts";
import { BarrierRefusal, canonical, digest } from "./manifest.ts";
import type { FleetConfiguration } from "../../src/pool/runtime-fleet/configuration.ts";

const rewriteImage = async (
  f: SettlementFixture,
  change: (record: RuntimeReleaseRecord) => RuntimeReleaseRecord,
) => {
  const journal = await Effect.runPromise(
    f.provide(runtimeReleaseJournal(f.scope, f.writer(f.sourceCandidate), f.key)),
  );
  await journal.write(change(f.record));
};
const rewriteForward = (f: SettlementFixture, receipt: Partial<ForwardPacket["receipt"]>) =>
  Effect.runPromise(
    writeForwardJournal(
      f.state,
      f.scope,
      f.key,
      { ...f.packet, receipt: { ...f.packet.receipt, ...receipt } },
      true,
    ),
  );
const ForwardHead = Schema.Struct({
  candidate: Schema.String,
  manifest: Schema.String,
  complete: Schema.Boolean,
  sealed: Schema.Unknown,
});
const slotIdentity = {
  format: "pool-runtime-slot-v1" as const,
  controllerId: "f".repeat(64),
  slotId: "legacy",
  applicationId: "pool-app",
  applicationVersion: "1",
  instanceId: "f".repeat(64),
  imageDigest: `sha256:${"1".repeat(64)}`,
  imageInput: "a".repeat(16),
  bootId: "baseline-boot",
};
const fleetConfiguration: FleetConfiguration = {
  format: "pool-runtime-fleet-v1",
  controllerCode: { candidate: "a".repeat(40), workerInput: "b".repeat(64) },
  controllerId: slotIdentity.controllerId,
  legacy: slotIdentity,
  revision: 1,
  previousDigest: null,
  active: "blue",
  applications: (["blue", "green"] as const).map((color) => ({
    color,
    accountId: "1".repeat(32),
    applicationId: `${color}-app`,
    namespaceId: `${color}-namespace`,
    applicationVersion: "1",
    imageDigest: slotIdentity.imageDigest,
    applicationConfigDigest: "5".repeat(64),
    imageInput: "a".repeat(16),
  })),
  maximum: 4,
  targetActive: 25,
  idleMilliseconds: 60_000,
};
const permission = (enabled: boolean) => ({
  operationId: "configure",
  digest: "6".repeat(64),
  enabled,
  configuration: fleetConfiguration,
});
const notInstalled = async (): Promise<never> => {
  throw new BarrierRefusal("runtime-release-controller-not-installed", "PoolWorker");
};

test("an activated controller that never adopted its runtime is archived and lets only the named next candidate proceed", async (context) => {
  const f = await controllerActiveFixture(context);
  const next = await Effect.runPromise(
    f.provide(runtimeReleaseJournal(f.scope, f.writer(), f.key)),
  );
  await assert.rejects(next.read(), /prior-candidate-unsettled/);
  const manifest = await planSettlement(f);
  assert.equal(f.writes(), 0);
  assert.ok("controllerReads" in manifest.proof);
  assert.deepEqual(manifest.proof.controllerReads, {
    // sha256 of the canonical empty fleet result {"bindings":[],"resources":[]}
    fleetDigest: "f1822eea28adffdff9f371a1d522a155668959811a0107381521b3c437f51235",
    witness: "absent",
    finalInspect: "no-selection",
  });
  for (const call of f.calls)
    assert.match(
      call,
      /^(GET (deployment|health|placement \w+|baseline \w+)|POST (inspect|fleet-inspect|witness))$/,
    );
  assert.deepEqual(
    f.calls.filter((call) => call.startsWith("POST")),
    ["POST inspect", "POST fleet-inspect", "POST witness", "POST inspect"],
  );
  assert.deepEqual(
    f.runtimeReads.map((call) => `${call.method} ${call.action ?? call.path}`),
    ["POST inspect", "GET /runtime-recovery", "POST fleet-inspect", "POST witness", "POST inspect"],
  );
  const receipt = await Effect.runPromise(
    f.provide(
      applyReleaseSettlement(
        f.compiled,
        manifest,
        f.key,
        {
          coordinatorGo: "apply-reviewed-packet",
          writerLease: f.provisioningWriter.lease,
          manifest: releaseSettlementDigest(manifest),
          expiresAt: Date.now() + 60_000,
        },
        f.io,
      ),
    ),
  );
  assert.equal(receipt.stateWrites, 1);
  assert.equal(f.writes(), 1);
  const archive = await Effect.runPromise(
    f.state.getOutput(releaseSettlementKey(f.scope, f.sourceCandidate, f.candidate)),
  );
  const saved = openReleaseSettlement(archive, f.key, f.sourceCandidate, f.candidate);
  assert.equal(saved.manifest.proof.disposition, "controller-active-unadopted");
  assert.equal(await next.read(), undefined);
  const headBefore = await Effect.runPromise(f.state.getOutput(journalKey(f.scope)));
  // The finished controller phase left the head complete, so the next candidate's first release
  // step finds nothing to reconcile and never touches the head the archive is bound to.
  const reconciled = await Effect.runPromise(
    f.provide(
      resumeForwardRelease(f.compiled, {
        directory: f.io.directory,
        io: { ...f.io.forward, container: f.io.container },
        // The next candidate passes its health read here; a complete head never calls it.
        runtime: notInstalled,
      }),
    ),
  );
  assert.equal(reconciled, undefined);
  const headAfter = await Effect.runPromise(f.state.getOutput(journalKey(f.scope)));
  assert.equal(digest(canonical(headAfter)), digest(canonical(headBefore)));
  assert.equal(Schema.decodeUnknownSync(ForwardHead)(headAfter).complete, true);
  assert.equal(
    manifest.proof.nativeBeforeDigest,
    manifest.proof.nativeResources.find((row) => row.fqn === "PoolContainer")?.digest,
  );
  assert.equal(await next.read(), undefined);
  const other = await Effect.runPromise(
    f.provide(runtimeReleaseJournal(f.scope, f.writer("d".repeat(40)), f.key)),
  );
  await assert.rejects(other.read(), /prior-candidate-unsettled/);
});

const controllerCodeDrift = (error: unknown) =>
  error instanceof BarrierRefusal &&
  error.reason === "provisioning-input-drift" &&
  error.delta?.changed[0]?.path === "release-settlement.controller-code";
const refusals: [
  string,
  RegExp | ((error: unknown) => boolean),
  (f: SettlementFixture) => unknown,
][] = [
  [
    "a request that does not name the source controller",
    /release-settlement-source-controller-unproven \(PoolWorker\)/,
    (f) => {
      f.sourceController = undefined;
    },
  ],
  [
    "a source controller of another candidate",
    /release-settlement-source-controller-unproven \(PoolWorker\)/,
    (f) => {
      f.sourceController = { ...f.code, candidate: "0".repeat(40) };
    },
  ],
  [
    "a source controller code the live controller does not hold",
    /baseline-controller-identity-refused \(PoolWorker\)/,
    (f) => {
      f.sourceController = { ...f.code, workerInput: "9".repeat(64) };
    },
  ],
  [
    "a selection at the first inspect",
    /baseline-controller-selection-unexpected/,
    (f) => (f.controller.selectionAt = "first"),
  ],
  [
    "a selection at the final inspect",
    /release-settlement-selection-present/,
    (f) => (f.controller.selectionAt = "final"),
  ],
  [
    "a refused final inspect",
    /release-settlement-controller-read-refused/,
    (f) => (f.controller.finalInspect = () => new Response(null, { status: 409 })),
  ],
  [
    "another controller code at the final inspect",
    controllerCodeDrift,
    (f) =>
      (f.controller.finalInspect = () =>
        Response.json({
          result: { controllerCode: { candidate: "0".repeat(40), workerInput: "b".repeat(64) } },
        })),
  ],
  [
    "a refused fleet read",
    /release-settlement-controller-read-refused/,
    (f) => (f.controller.fleetResponse = () => new Response(null, { status: 503 })),
  ],
  [
    "an enabled fleet permission",
    /release-settlement-fleet-present/,
    (f) => (f.controller.fleet = { ...f.controller.fleet, permission: permission(true) }),
  ],
  [
    "a disabled fleet permission",
    /release-settlement-fleet-present/,
    (f) => (f.controller.fleet = { ...f.controller.fleet, permission: permission(false) }),
  ],
  [
    "fleet resources",
    /release-settlement-fleet-present/,
    (f) =>
      (f.controller.fleet = {
        ...f.controller.fleet,
        resources: [{ target: slotIdentity, phase: "ready", active: 0 }],
      }),
  ],
  [
    "fleet bindings",
    /release-settlement-fleet-present/,
    (f) =>
      (f.controller.fleet = {
        ...f.controller.fleet,
        bindings: [{ color: "blue", applicationId: "blue-app", imageInput: "a".repeat(16) }],
      }),
  ],
  [
    "a witness refused for another reason",
    /release-settlement-witness-unproven \(PoolWorker\.witness\.409\.slot_selection\)/,
    (f) =>
      (f.controller.witness = () =>
        new Response(null, {
          status: 409,
          headers: {
            "X-Signalbox-Runtime-Failure-Step": "endpoint_route",
            "X-Signalbox-Runtime-Failure-Reason": "slot_selection",
          },
        })),
  ],
  [
    "a witness defect",
    /release-settlement-witness-unproven \(PoolWorker\.witness\.500\.none\)/,
    (f) => (f.controller.witness = () => new Response(null, { status: 500 })),
  ],
  [
    "an upload-phase receipt",
    /release-settlement-not-controller-active \(receipt\.phase\)/,
    (f) => rewriteForward(f, { phase: "upload" }),
  ],
  [
    "a pending upload",
    /release-settlement-not-controller-active \(receipt\.pendingUpload\)/,
    (f) => rewriteForward(f, { pendingUpload: { worker: "Api" } }),
  ],
  [
    "a Worker missing from activation",
    /release-settlement-not-controller-active \(receipt\.activated\)/,
    (f) =>
      rewriteForward(f, {
        activated: f.packet.receipt.activated.filter((row) => row.worker !== "Api"),
      }),
  ],
  [
    "a Worker rolled back to its baseline",
    /release-settlement-worker-not-accepted \(Api\)/,
    (f) => f.active.set("Api", [{ versionId: "old-Api", percentage: 100 }]),
  ],
  [
    "an image record that never froze the controller it replaced",
    /release-settlement-not-controller-active \(record\.baselineController\)/,
    (f) =>
      rewriteImage(f, (record) => {
        const unfrozen = { ...record };
        delete unfrozen.baselineController;
        return unfrozen;
      }),
  ],
  [
    "a root placement serving another image",
    /release-settlement-root-not-baseline \(PoolContainer\)/,
    (f) => {
      const read = f.io.forward!.observation!;
      f.io.forward!.observation = async (...args) => ({
        ...(await read(...args)),
        digest: `sha256:${"9".repeat(64)}`,
      });
    },
  ],
  [
    "a root rollout in progress",
    /release-settlement-root-not-baseline \(PoolContainer\)/,
    (f) => {
      const read = f.io.forward!.observation!;
      f.io.forward!.observation = async (...args) => ({
        ...(await read(...args)),
        activeRolloutId: "synthetic-rollout",
      });
    },
  ],
  [
    "a health boot outside the root placements",
    /baseline-controller-boot-instance-mismatch/,
    (f) => {
      const read = f.io.forward!.observation!;
      f.io.forward!.observation = async (...args) => {
        const value = await read(...args);
        return {
          ...value,
          instances: value.instances.map((row) => ({ ...row, id: "9".repeat(64) })),
        };
      };
    },
  ],
  [
    "a root instance that is not running",
    /baseline-controller-placement-unconfirmed/,
    (f) => {
      const read = f.io.forward!.observation!;
      f.io.forward!.observation = async (...args) => {
        const value = await read(...args);
        return {
          ...value,
          instances: value.instances.map((row) => ({ ...row, state: "stopped" })),
        };
      };
    },
  ],
  [
    "a root record changed since the controller phase",
    /forward-native-before-drift/,
    async (f) => {
      const key = { stack: f.scope.name, stage: f.scope.stage, fqn: "PoolContainer" };
      const row = await Effect.runPromise(f.memory.get(key));
      assert.ok(row);
      await Effect.runPromise(
        f.memory.set({ ...key, value: { ...row, downstream: ["synthetic"] } }),
      );
    },
  ],
  [
    "a container that changed",
    /release-settlement-not-controller-active \(receipt\.containers\)/,
    (f) =>
      rewriteForward(f, {
        containers: [{ container: "PoolContainer", version: 1, unchanged: false }],
      }),
  ],
  [
    "an image record with bootstrap",
    /release-settlement-not-controller-active \(record\.bootstrap\)/,
    (f) =>
      rewriteImage(f, (record) => ({
        ...record,
        bootstrap: { blue: provisioningFixture("PoolRuntimeBlue").manifest },
      })),
  ],
  [
    "an image record with a fleet configuration",
    /release-settlement-not-controller-active \(record\.configurations\)/,
    (f) =>
      rewriteImage(f, (record) => ({
        ...record,
        configurations: { configure: fleetConfiguration },
      })),
  ],
  [
    "an image record with a promotion",
    /release-settlement-not-controller-active \(record\.promotion\)/,
    async (f) => {
      const startup = (await runtimeProofFixture()).manifest;
      await rewriteImage(f, (record) => ({
        ...record,
        promotion: { operationId: startup.operationId, pool: "pool", generation: 0, startup },
      }));
    },
  ],
];
for (const [name, reason, change] of refusals)
  test(`controller-active settlement refuses ${name}`, async (context) => {
    const f = await controllerActiveFixture(context);
    await change(f);
    await assert.rejects(planSettlement(f), reason);
    assert.equal(f.writes(), 0);
  });

test("each disposition refuses the other's source state", async (context) => {
  await assert.rejects(
    planSettlement(await controllerActiveFixture(context), "abandoned-before-controller"),
    /release-settlement-not-pre-controller \(PoolWorker\)/,
  );
  await assert.rejects(
    planSettlement(await releaseSettlementFixture(context)),
    /release-settlement-not-controller-active \(forward\.complete\)/,
  );
});

test("controller-active settlement refuses a forward head its controller phase never completed", async (context) => {
  const f = await controllerActiveFixture(context);
  await Effect.runPromise(writeForwardJournal(f.state, f.scope, f.key, f.packet, false));
  await assert.rejects(
    planSettlement(f),
    /release-settlement-not-controller-active \(forward\.complete\)/,
  );
  assert.equal(f.writes(), 0);
});
