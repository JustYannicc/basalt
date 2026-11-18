import assert from "node:assert/strict";
import { test } from "node:test";
import { Effect, Schema } from "effect";
import {
  controllerAdoptedFixture,
  fixtureAdoptionTarget,
  planSettlement,
  type SettlementFixture,
} from "./test/settlement-plan.ts";
import { applyReleaseSettlement } from "./release-settlement-operation.ts";
import {
  ReleaseSettlementProof,
  releaseSettlementDigest,
  releaseSettlementKey,
} from "./release-settlement-contract.ts";
import { openReleaseSettlement } from "./release-settlement-archive.ts";
import { runtimeReleaseJournal } from "./runtime-release-journal.ts";
import { journalKey, writeForwardJournal } from "./forward-journal.ts";
import { resumeForwardRelease } from "./forward-resume.ts";
import { BarrierRefusal, canonical, digest } from "./manifest.ts";
import { launchWitnessKey } from "../../src/pool/runtime-slots/admission-proof.ts";
import { slotSelectionKey } from "../../src/pool/runtime-slots/storage.ts";

const identity = { ...fixtureAdoptionTarget, bootId: "baseline-boot" };
const selected = { epoch: 1, active: { target: fixtureAdoptionTarget, identity, fenced: false } };
const fleetPrimary = {
  ...fixtureAdoptionTarget,
  slotId: "fleet-blue",
  applicationId: "blue-app",
  instanceId: "c".repeat(64),
};
const notInstalled = async (): Promise<never> => {
  throw new BarrierRefusal("runtime-release-controller-not-installed", "PoolWorker");
};
const select = (f: SettlementFixture, selection: unknown) =>
  f.controller.storage.put(slotSelectionKey, selection);
const healthJson = async (live: () => Promise<Response>) => {
  const response = await live();
  assert.equal(response.status, 200);
  return Schema.decodeUnknownSync(
    Schema.Struct({ result: Schema.Struct({ identity: Schema.Unknown, leaseMs: Schema.Number }) }),
  )(await response.json()).result;
};
const rewritten = async (
  live: () => Promise<Response>,
  change: (result: Record<string, unknown>) => Record<string, unknown>,
) => {
  const response = await live();
  assert.equal(response.status, 200);
  const { result } = Schema.decodeUnknownSync(
    Schema.Struct({ result: Schema.Record(Schema.String, Schema.Unknown) }),
  )(await response.json());
  return Response.json({ result: change(result) });
};
const countBridges = (f: SettlementFixture) => {
  const connect = f.io.connect!;
  let opened = 0;
  f.io.connect = async (...args) => {
    opened++;
    return connect(...args);
  };
  return () => opened;
};

test("a source whose adopt committed the legacy root is archived and lets only the named next candidate proceed", async (context) => {
  const f = await controllerAdoptedFixture(context);
  const next = await Effect.runPromise(
    f.provide(runtimeReleaseJournal(f.scope, f.writer(), f.key)),
  );
  await assert.rejects(next.read(), /prior-candidate-unsettled/);
  // The earlier dispositions cannot settle this state: one sees the selection, one the finished head.
  await assert.rejects(
    planSettlement(f, "controller-active-unadopted"),
    /baseline-controller-selection-unexpected \(PoolWorker\)/,
  );
  await assert.rejects(
    planSettlement(f, "abandoned-before-controller"),
    /release-settlement-not-pre-controller \(PoolWorker\)/,
  );
  const reads = f.runtimeReads.length,
    calls = f.calls.length;
  const bridges = countBridges(f);
  const manifest = await planSettlement(f, "controller-active-adopted");
  assert.equal(f.writes(), 0);
  assert.equal(bridges(), 1);
  assert.equal(manifest.proof.disposition, "controller-active-adopted");
  assert.ok("controllerReads" in manifest.proof);
  assert.deepEqual(manifest.proof.controllerReads, {
    // sha256 of the canonical empty fleet result {"bindings":[],"resources":[]}
    fleetDigest: "f1822eea28adffdff9f371a1d522a155668959811a0107381521b3c437f51235",
    witness: "unattested-adoption",
    selection: { epoch: 1, identity },
  });
  assert.deepEqual(manifest.proof.health, {
    instanceId: identity.instanceId,
    bootId: "baseline-boot",
  });
  assert.equal(manifest.proof.controller.code.candidate, f.sourceCandidate);
  assert.deepEqual(
    f.runtimeReads.slice(reads).map((call) => `${call.method} ${call.action ?? call.path}`),
    ["POST inspect", "POST active-health", "POST fleet-inspect", "POST witness", "POST inspect"],
  );
  for (const call of f.calls.slice(calls))
    assert.match(
      call,
      /^(GET (deployment|placement \w+|baseline \w+)|POST (inspect|active-health|fleet-inspect|witness))$/,
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
  assert.equal(receipt.runtimeMutations, 0);
  assert.equal(f.writes(), 1);
  const archive = await Effect.runPromise(
    f.state.getOutput(releaseSettlementKey(f.scope, f.sourceCandidate, f.candidate)),
  );
  const saved = openReleaseSettlement(archive, f.key, f.sourceCandidate, f.candidate);
  assert.equal(saved.manifest.proof.disposition, "controller-active-adopted");
  assert.equal(await next.read(), undefined);
  const headBefore = await Effect.runPromise(f.state.getOutput(journalKey(f.scope)));
  const reconciled = await Effect.runPromise(
    f.provide(
      resumeForwardRelease(f.compiled, {
        directory: f.io.directory,
        io: { ...f.io.forward, container: f.io.container },
        runtime: notInstalled,
      }),
    ),
  );
  assert.equal(reconciled, undefined);
  const headAfter = await Effect.runPromise(f.state.getOutput(journalKey(f.scope)));
  assert.equal(digest(canonical(headAfter)), digest(canonical(headBefore)));
  const other = await Effect.runPromise(
    f.provide(runtimeReleaseJournal(f.scope, f.writer("d".repeat(40)), f.key)),
  );
  await assert.rejects(other.read(), /prior-candidate-unsettled/);
});

test("a slow bridge open or read record does not count against the active runtime's lease", async (context) => {
  const f = await controllerAdoptedFixture(context);
  const connect = f.io.connect!;
  f.io.connect = async (...args) => {
    await new Promise((resolve) => setTimeout(resolve, 1_200));
    return connect(...args);
  };
  const recordRead = f.io.runtimeRead!;
  f.io.runtimeRead = async (call) => {
    await new Promise((resolve) => setTimeout(resolve, 300));
    return recordRead(call);
  };
  f.controller.activeHealth = async (live) =>
    Response.json({ result: { ...(await healthJson(live)), leaseMs: 1_000 } });
  assert.equal(
    (await planSettlement(f, "controller-active-adopted")).proof.disposition,
    "controller-active-adopted",
  );
});

test("each controller-active proof carries only its own controller reads", async (context) => {
  const manifest = await planSettlement(
    await controllerAdoptedFixture(context),
    "controller-active-adopted",
  );
  assert.ok(manifest.proof.disposition === "controller-active-adopted");
  const reads = manifest.proof.controllerReads;
  const strict = Schema.decodeUnknownSync(ReleaseSettlementProof, { onExcessProperty: "error" });
  const unadopted = {
    fleetDigest: "4".repeat(64),
    witness: "absent",
    finalInspect: "no-selection",
  };
  assert.throws(() => strict({ ...manifest.proof, controllerReads: unadopted }));
  assert.throws(() => strict({ ...manifest.proof, disposition: "controller-active-unadopted" }));
  assert.throws(() =>
    strict({
      ...manifest.proof,
      controllerReads: { ...reads, selection: { epoch: 2, identity } },
    }),
  );
  assert.equal(strict(manifest.proof).disposition, "controller-active-adopted");
});

const refusals: [string, RegExp, (f: SettlementFixture) => unknown][] = [
  [
    "a request that does not name the source controller",
    /release-settlement-source-controller-unproven \(PoolWorker\)/,
    (f) => {
      f.sourceController = undefined;
    },
  ],
  [
    "a source controller code the live controller does not hold",
    /release-settlement-controller-identity-refused \(PoolWorker\)/,
    (f) => {
      f.sourceController = { ...f.code, workerInput: "9".repeat(64) };
    },
  ],
  [
    "a refused first inspect",
    /release-settlement-controller-read-refused \(PoolWorker\)/,
    (f) => (f.controller.firstInspect = () => new Response(null, { status: 503 })),
  ],
  [
    "an inspect answered under another controller code",
    /release-settlement-controller-identity-refused \(PoolWorker\)/,
    (f) =>
      (f.controller.firstInspect = (live) =>
        rewritten(live, (result) => ({
          ...result,
          controllerCode: { ...f.code, workerInput: "9".repeat(64) },
        }))),
  ],
  [
    "an active identity that is not its target and boot",
    /release-settlement-adopted-selection-unexpected \(selection\.identity\)/,
    (f) =>
      (f.controller.firstInspect = (live) =>
        rewritten(live, (result) => ({
          ...result,
          selection: {
            ...selected,
            active: { ...selected.active, identity: { ...identity, applicationVersion: "2" } },
          },
        }))),
  ],
  [
    "a retiring active slot",
    /release-settlement-adopted-selection-unexpected \(selection\.retirement\)/,
    (f) =>
      select(f, {
        ...selected,
        active: { ...selected.active, retirement: { operationId: "retire", status: "started" } },
      }),
  ],
  [
    "a witness for another boot",
    /release-settlement-adoption-witness-unexpected \(witness\.identity\)/,
    (f) =>
      (f.controller.witness = (live) =>
        rewritten(live, (result) => ({
          ...result,
          identity: { ...identity, bootId: "other-boot" },
        }))),
  ],
  [
    "a witness under another controller code",
    /release-settlement-adoption-witness-unexpected \(witness\.controllerCode\)/,
    (f) =>
      (f.controller.witness = (live) =>
        rewritten(live, (result) => ({
          ...result,
          controllerCode: { ...f.code, workerInput: "9".repeat(64) },
        }))),
  ],
  [
    "a refused final inspect",
    /release-settlement-controller-read-refused \(PoolWorker\)/,
    (f) => (f.controller.finalInspect = () => new Response(null, { status: 503 })),
  ],
  [
    "no selection",
    /release-settlement-adopted-selection-unexpected \(selection\.absent\)/,
    (f) => f.controller.storage.values.delete(slotSelectionKey),
  ],
  [
    // Only recovery commits past epoch 1, and its restart replaces adopt's unattested witness.
    "a selection past its first epoch that recovery never restarted",
    /release-settlement-witness-unproven \(PoolWorker\.witness\.409\.slot_identity\)/,
    (f) => select(f, { ...selected, epoch: 2 }),
  ],
  [
    "a fleet primary as the active slot",
    /release-settlement-adopted-selection-unexpected \(selection\.target\)/,
    (f) =>
      select(f, {
        epoch: 1,
        active: {
          target: fleetPrimary,
          identity: { ...fleetPrimary, bootId: "fleet-boot" },
          fenced: false,
        },
      }),
  ],
  [
    "a fenced active slot",
    /release-settlement-adopted-selection-unexpected \(selection\.fenced\)/,
    (f) => select(f, { ...selected, active: { ...selected.active, fenced: true } }),
  ],
  [
    "a pending candidate",
    /release-settlement-adopted-selection-unexpected \(selection\.candidate\)/,
    (f) => select(f, { ...selected, candidate: { target: fleetPrimary, fenced: false } }),
  ],
  [
    "a draining slot",
    /release-settlement-adopted-selection-unexpected \(selection\.draining\)/,
    (f) => select(f, { ...selected, draining: { target: fleetPrimary, fenced: false } }),
  ],
  [
    "a selected root on an instance outside the root placements",
    /release-settlement-adopted-selection-unexpected \(selection\.target\)/,
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
    /baseline-controller-placement-unconfirmed \(PoolWorker\)/,
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
    "a fleet permission",
    /release-settlement-fleet-present \(PoolWorker\)/,
    (f) =>
      (f.controller.fleet = {
        ...f.controller.fleet,
        permission: { operationId: "configure", digest: "6".repeat(64), enabled: false },
      }),
  ],
  [
    "fleet rows",
    /release-settlement-fleet-present \(PoolWorker\)/,
    (f) =>
      (f.controller.fleet = {
        ...f.controller.fleet,
        resources: [{ target: fleetPrimary, phase: "ready", active: 0 }],
      }),
  ],
  [
    "a witness that is not the unattested adoption",
    /release-settlement-adoption-witness-unexpected \(witness\.kind\)/,
    (f) =>
      (f.controller.witness = () =>
        Response.json({ result: { kind: "witness", controllerCode: f.code, witness: {} } })),
  ],
  [
    "a witness another adopt retained",
    /release-settlement-adoption-witness-unexpected \(witness\.operationId\)/,
    (f) => {
      const key = launchWitnessKey("legacy");
      const record = Schema.decodeUnknownSync(
        Schema.Struct({ authorization: Schema.Record(Schema.String, Schema.Unknown) }),
      )(f.controller.storage.values.get(key));
      const raw = f.controller.storage.values.get(key) as object;
      f.controller.storage.values.set(key, {
        ...raw,
        authorization: { ...record.authorization, operationId: `adopt-${"d".repeat(40)}` },
      });
    },
  ],
  [
    "a refused witness",
    /release-settlement-witness-unproven \(PoolWorker\.witness\.409\.none\)/,
    (f) => (f.controller.witness = () => new Response(null, { status: 409 })),
  ],
  [
    "an active health for another boot",
    /release-settlement-active-health-identity \(PoolWorker\)/,
    (f) =>
      (f.controller.activeHealth = async (live) =>
        Response.json({
          result: { ...(await healthJson(live)), identity: { ...identity, bootId: "other-boot" } },
        })),
  ],
  [
    "an active health whose lease expired during its own request",
    /release-settlement-active-health-expired \(PoolWorker\)/,
    (f) =>
      (f.controller.activeHealth = async (live) => {
        const health = await healthJson(live);
        await new Promise((resolve) => setTimeout(resolve, 60));
        return Response.json({ result: { ...health, leaseMs: 20 } });
      }),
  ],
  [
    "a refused active health",
    /release-settlement-controller-read-refused \(PoolWorker\)/,
    (f) => (f.controller.bootId = "restarted-boot"),
  ],
  [
    "a selection that changed before the final inspect",
    /release-settlement-selection-changed \(PoolWorker\)/,
    (f) =>
      (f.controller.finalInspect = async (live) => {
        await select(f, { ...selected, active: { ...selected.active, fenced: true } });
        return live();
      }),
  ],
  [
    "a forward head its controller phase never completed",
    /release-settlement-not-controller-active \(forward\.complete\)/,
    (f) => Effect.runPromise(writeForwardJournal(f.state, f.scope, f.key, f.packet, false)),
  ],
  [
    "a Worker rolled back to its baseline",
    /release-settlement-worker-not-accepted \(Api\)/,
    (f) => f.active.set("Api", [{ versionId: "old-Api", percentage: 100 }]),
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
];
for (const [name, reason, change] of refusals)
  test(`controller-active-adopted settlement refuses ${name}`, async (context) => {
    const f = await controllerAdoptedFixture(context);
    await change(f);
    await assert.rejects(planSettlement(f, "controller-active-adopted"), reason);
    assert.equal(f.writes(), 0);
    assert.ok(!f.runtimeReads.some((call) => call.method === "GET"));
  });
