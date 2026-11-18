import assert from "node:assert/strict";
import { test } from "node:test";
import { Effect, Schema } from "effect";
import {
  controllerRecoveredFixture,
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
import { slotSelectionKey } from "../../src/pool/runtime-slots/storage.ts";

const identity = { ...fixtureAdoptionTarget, bootId: "recovered-boot-2" };
const Fields = Schema.Record(Schema.String, Schema.Unknown);
const fields = Schema.decodeUnknownSync(Fields);
const rewritten = async (
  live: () => Promise<Response>,
  change: (result: Record<string, unknown>) => Record<string, unknown>,
) => {
  const response = await live();
  assert.equal(response.status, 200);
  const { result } = Schema.decodeUnknownSync(Schema.Struct({ result: Fields }))(
    await response.json(),
  );
  return Response.json({ result: change(result) });
};
const rewrittenWitness = (
  f: SettlementFixture,
  change: (witness: Record<string, unknown>) => Record<string, unknown>,
) =>
  (f.controller.witness = (live) =>
    rewritten(live, (result) => ({
      ...result,
      witness: change(fields(result.witness)),
    })));
const apply = (f: SettlementFixture, manifest: Awaited<ReturnType<typeof planSettlement>>) =>
  Effect.runPromise(
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

test("an adopted root the controller has since recovered twice is archived and releases only the named next candidate", async (context) => {
  const f = await controllerRecoveredFixture(context);
  const next = await Effect.runPromise(
    f.provide(runtimeReleaseJournal(f.scope, f.writer(), f.key)),
  );
  await assert.rejects(next.read(), /prior-candidate-unsettled/);
  const reads = f.runtimeReads.length;
  const manifest = await planSettlement(f, "controller-active-adopted");
  assert.equal(f.writes(), 0);
  assert.ok(manifest.proof.disposition === "controller-active-adopted");
  assert.deepEqual(manifest.proof.controllerReads, {
    fleetDigest: "f1822eea28adffdff9f371a1d522a155668959811a0107381521b3c437f51235",
    witness: "recovered-restart",
    selection: { epoch: 3, identity },
  });
  assert.deepEqual(manifest.proof.health, {
    instanceId: identity.instanceId,
    bootId: "recovered-boot-2",
  });
  assert.deepEqual(
    f.runtimeReads.slice(reads).map((call) => `${call.method} ${call.action ?? call.path}`),
    ["POST inspect", "POST active-health", "POST fleet-inspect", "POST witness", "POST inspect"],
  );
  const strict = Schema.decodeUnknownSync(ReleaseSettlementProof, { onExcessProperty: "error" });
  assert.equal(strict(manifest.proof).disposition, "controller-active-adopted");
  // Each witness literal pins its own epochs.
  for (const [controllerReads, refused] of [
    [
      { ...manifest.proof.controllerReads, selection: { epoch: 1, identity } },
      /Expected a value greater than 1\s+at \["controllerReads"\]\["selection"\]\["epoch"\]/,
    ],
    [
      { ...manifest.proof.controllerReads, witness: "unattested-adoption" },
      /at \["controllerReads"\]\["(witness|selection)"\]/,
    ],
  ] as const)
    assert.throws(() => strict({ ...manifest.proof, controllerReads }), refused);
  const receipt = await apply(f, manifest);
  assert.equal(receipt.stateWrites, 1);
  assert.equal(receipt.runtimeMutations, 0);
  const archive = await Effect.runPromise(
    f.state.getOutput(releaseSettlementKey(f.scope, f.sourceCandidate, f.candidate)),
  );
  const saved = openReleaseSettlement(archive, f.key, f.sourceCandidate, f.candidate);
  assert.deepEqual(saved.manifest.proof, manifest.proof);
  assert.equal(await next.read(), undefined);
});

test("a root restarted again between plan and apply refuses apply", async (context) => {
  const f = await controllerRecoveredFixture(context);
  const manifest = await planSettlement(f, "controller-active-adopted");
  await f.controller.restart("recovered-boot-3");
  await assert.rejects(apply(f, manifest), /release-settlement-plan-drift \(PoolWorker\)/);
  assert.equal(f.writes(), 0);
  // The new epoch is itself settleable; it needs its own reviewed plan.
  const replanned = await planSettlement(f, "controller-active-adopted");
  assert.ok(replanned.proof.disposition === "controller-active-adopted");
  assert.deepEqual(replanned.proof.controllerReads.selection, {
    epoch: 4,
    identity: { ...identity, bootId: "recovered-boot-3" },
  });
});

const other = { candidate: "a".repeat(40), workerInput: "9".repeat(64) };
const refusals: [string, RegExp, (f: SettlementFixture) => unknown][] = [
  [
    "an unattested witness at a recovered epoch",
    /release-settlement-adoption-witness-unexpected \(witness\.kind\)/,
    (f) =>
      (f.controller.witness = () =>
        Response.json({ result: { kind: "unattested-active", controllerCode: f.code } })),
  ],
  [
    "a witness answer with fields beyond the startup witness",
    /release-settlement-adoption-witness-unexpected \(witness\.shape\)/,
    (f) => rewrittenWitness(f, (witness) => ({ ...witness, retired: true })),
  ],
  [
    "a witness under another controller code",
    /release-settlement-adoption-witness-unexpected \(witness\.controllerCode\)/,
    (f) =>
      (f.controller.witness = (live) =>
        rewritten(live, (result) => ({ ...result, controllerCode: other }))),
  ],
  [
    "a witness for another target",
    /release-settlement-adoption-witness-unexpected \(witness\.target\)/,
    (f) =>
      rewrittenWitness(f, (witness) => ({
        ...witness,
        target: { ...fixtureAdoptionTarget, applicationVersion: "2" },
      })),
  ],
  [
    "a witness for another boot",
    /release-settlement-adoption-witness-unexpected \(witness\.bootId\) expected=recovered-boot-2 observed=other-boot$/,
    (f) => rewrittenWitness(f, (witness) => ({ ...witness, bootId: "other-boot" })),
  ],
  [
    "a witness whose launch never reported a boot",
    /release-settlement-adoption-witness-unexpected \(witness\.bootId\) expected=recovered-boot-2$/,
    (f) =>
      rewrittenWitness(f, (witness) => {
        delete witness.bootId;
        return witness;
      }),
  ],
  [
    "a witness some other operation launched",
    /release-settlement-adoption-witness-unexpected \(witness\.operationId\)/,
    (f) =>
      rewrittenWitness(f, (witness) => ({ ...witness, operationId: `adopt-${"a".repeat(40)}` })),
  ],
  [
    // An initial start names its launch by the release's UUID operation, never a restart.
    "an initial-start witness at a recovered epoch",
    /release-settlement-adoption-witness-unexpected \(witness\.operationId\)$/,
    (f) =>
      rewrittenWitness(f, (witness) => ({
        ...witness,
        operationId: "3f2b9c1e-7a4d-4e8f-9b6a-1c2d3e4f5a6b",
      })),
  ],
  [
    "a refused witness",
    /release-settlement-witness-unproven \(PoolWorker\.witness\.409\.none\)/,
    (f) => (f.controller.witness = () => new Response(null, { status: 409 })),
  ],
  [
    "a root restarted again before the final inspect",
    /release-settlement-selection-changed \(selection\.epoch\) expected=3 observed=4 observedBoot=recovered-boot-3$/,
    (f) =>
      (f.controller.finalInspect = async (live) => {
        await f.controller.restart("recovered-boot-3");
        return live();
      }),
  ],
  [
    "a selection removed before the final inspect",
    /release-settlement-selection-changed \(selection\.absent\)/,
    (f) =>
      (f.controller.finalInspect = async (live) => {
        f.controller.storage.values.delete(slotSelectionKey);
        return live();
      }),
  ],
  [
    "a selection before any epoch",
    /release-settlement-adopted-selection-unexpected \(selection\.epoch\)/,
    (f) =>
      (f.controller.firstInspect = (live) =>
        rewritten(live, (result) => ({
          ...result,
          selection: { ...fields(result.selection), epoch: 0 },
        }))),
  ],
];
for (const [name, reason, change] of refusals)
  test(`recovered controller-active-adopted settlement refuses ${name}`, async (context) => {
    const f = await controllerRecoveredFixture(context);
    await change(f);
    await assert.rejects(planSettlement(f, "controller-active-adopted"), reason);
    assert.equal(f.writes(), 0);
    assert.ok(!f.runtimeReads.some((call) => call.method === "GET"));
  });
