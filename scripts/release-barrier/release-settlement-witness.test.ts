import assert from "node:assert/strict";
import { test } from "node:test";
import { Effect, Schema } from "effect";
import { releaseSettlementFixture } from "./test/release-settlement-fixture.ts";
import {
  controllerActiveFixture,
  fixtureAdoptionTarget,
  planSettlement,
  type SettlementFixture,
} from "./test/settlement-plan.ts";
import {
  ReleaseSettlementPlanRequest,
  ReleaseSettlementProof,
} from "./release-settlement-contract.ts";
import { legacyAdoptionTarget } from "./legacy-adoption-target.ts";
import { runtimeReleaseState } from "./runtime-release-state.ts";
import { canonical } from "./manifest.ts";
import { runtimeResponseDiagnostic } from "../../src/pool/runtime-route-diagnostic.ts";
import {
  runtimeHandoffCommandPrefix,
  runtimeHandoffPath,
} from "../../src/pool/runtime-slots/handoff-command.ts";
import { launchWitnessKey } from "../../src/pool/runtime-slots/admission-proof.ts";
import { signEnvelope } from "../../src/pool/token.ts";

const liveWitness = async (f: SettlementFixture) => {
  const at = Date.now();
  const response = await f.controller.live(
    new Request(`http://pool-operations${runtimeHandoffPath}`, {
      method: "POST",
      body: JSON.stringify({
        envelope: await signEnvelope(f.key, runtimeHandoffCommandPrefix, {
          action: "witness",
          target: fixtureAdoptionTarget,
          controllerCode: { candidate: f.sourceCandidate, workerInput: "b".repeat(64) },
          at,
          expiresAt: at + 60_000,
        }),
      }),
    }),
  );
  await response.body?.cancel();
  return response;
};

test("adopt and settlement build the same legacy slot target, and refuse an image without a digest", async (context) => {
  const f = await controllerActiveFixture(context);
  const { root } = (await Effect.runPromise(f.provide(runtimeReleaseState(f.scope)))).applications;
  assert.deepEqual(legacyAdoptionTarget(root, "f".repeat(64)), fixtureAdoptionTarget);
  const unpinned = {
    ...root,
    attributes: {
      ...root.attributes,
      configuration: { ...root.attributes.configuration, image: "registry.invalid/pool:latest" },
    },
  };
  assert.throws(
    () => legacyAdoptionTarget(unpinned, "f".repeat(64)),
    /legacy-adoption-image-digest-missing \(PoolContainer\)/,
  );
});

test("the live handoff refuses a never-adopted legacy witness as slot_identity", async (context) => {
  const f = await controllerActiveFixture(context);
  const response = await liveWitness(f);
  assert.equal(response.status, 409);
  assert.deepEqual(runtimeResponseDiagnostic(response), {
    runtimeStep: "endpoint_route",
    runtimeReason: "slot_identity",
  });
  assert.equal(f.controller.storage.values.size, 0);
});

test("a witness record retained for the adopt target refuses settlement as a retained adoption", async (context) => {
  const f = await controllerActiveFixture(context);
  await f.controller.retain("start", fixtureAdoptionTarget);
  assert.ok(f.controller.storage.values.has(launchWitnessKey("legacy")));
  assert.equal((await liveWitness(f)).status, 200);
  await assert.rejects(planSettlement(f), /release-settlement-retained-adoption/);
  assert.equal(f.writes(), 0);
});

test("an adoption that retained its witness but never committed a selection stays unsettled", async (context) => {
  const f = await controllerActiveFixture(context);
  await f.controller.retain("unattested-active", fixtureAdoptionTarget);
  const response = await liveWitness(f);
  assert.equal(response.status, 409);
  assert.equal(runtimeResponseDiagnostic(response)?.runtimeReason, "slot_selection");
  await assert.rejects(
    planSettlement(f),
    /release-settlement-witness-unproven \(PoolWorker\.witness\.409\.slot_selection\)/,
  );
  assert.equal(f.writes(), 0);
});

test("an earlier request without a disposition still decodes and settles before the controller", async (context) => {
  const request = {
    kind: "release-settlement",
    sourceCandidate: "a".repeat(40),
    operationId: "settle-before-controller",
    coordinatorGo: "read-only-plan",
    expiresAt: 1,
  };
  const decoded = Schema.decodeUnknownSync(ReleaseSettlementPlanRequest, {
    onExcessProperty: "error",
  })(request);
  assert.ok(!("disposition" in decoded));
  assert.equal(canonical(decoded), canonical(request));
  const manifest = await planSettlement(await releaseSettlementFixture(context), "omitted");
  assert.equal(manifest.proof.disposition, "abandoned-before-controller");
  assert.ok(!("controllerReads" in manifest.proof));
  const strict = Schema.decodeUnknownSync(ReleaseSettlementProof, { onExcessProperty: "error" });
  const reads = { fleetDigest: "4".repeat(64), witness: "absent", finalInspect: "no-selection" };
  assert.throws(() => strict({ ...manifest.proof, controllerReads: reads }));
  assert.throws(() => strict({ ...manifest.proof, disposition: "controller-active-unadopted" }));
  assert.equal(
    strict({
      ...manifest.proof,
      disposition: "controller-active-unadopted",
      controllerReads: reads,
    }).disposition,
    "controller-active-unadopted",
  );
});
