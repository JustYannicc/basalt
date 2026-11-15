import assert from "node:assert/strict";
import { firstHandoffFlow } from "./first-handoff-flow.mjs";
import { openEnvelope } from "../../../src/pool/token.ts";
import { policyHeader, policyUsePrefix } from "../../../src/pool/membership-contract.ts";
import { retainFirstHandoffExecution } from "./first-handoff-execution.mjs";

async function positive() {
  const f = await firstHandoffFlow({ proveRetainedModel: true });
  try {
    let oldAssertions = 0,
      candidateAssertions = 0;
    for (const [runtime, verified] of [
      [f.old, () => oldAssertions++],
      [f.candidate, () => candidateAssertions++],
    ]) {
      runtime.hooks.model = async (request) => {
        const envelope = request.headers.get(policyHeader);
        assert.ok(envelope);
        const claims = await openEnvelope(
          runtime.env.POOL_APP_SIGNING_KEY,
          policyUsePrefix,
          envelope,
        );
        assert.equal(claims.pool, f.claims.pool);
        assert.equal(claims.revision, f.policy.revision);
        verified();
      };
    }
    const result = await f.activate();
    assert.equal(result.disposition, "first-handoff-complete");
    const actions = f.events.map((e) => e.action);
    const adopt = actions.indexOf("adopt"),
      readback = actions.indexOf("witness"),
      advancedUpload = f.events.findIndex(
        (e) => e.action === "upload" && e.desired === f.candidate.target.imageInput,
      );
    assert(adopt >= 0 && readback > adopt && advancedUpload > readback);
    for (const event of f.events.slice(0, readback + 1))
      assert.equal(event.desired, f.old.target.imageInput);
    assert.equal(f.events[adopt].http, 200);
    assert.equal(f.events[readback].http, 200);
    assert.equal(f.old.calls.start, 0);
    assert.equal(f.candidate.calls.start, 1);
    assert.equal(f.old.calls.destroy, 1);
    assert.equal(f.candidate.calls.destroy, 0);
    assert.equal(result.active.instanceId, f.candidate.target.instanceId);
    assert.equal(result.active.bootId, f.candidate.identity().bootId);
    const ready = await f.worker().deploymentReady();
    assert.equal(ready.instanceId, f.candidate.target.instanceId);
    assert.equal(ready.bootId, result.active.bootId);
    const model = await f.model();
    assert.equal(model.status, 200);
    assert.equal(model.headers.get("X-Signalbox-Pool-Boot"), result.active.bootId);
    await model.body?.cancel();
    assert.equal(oldAssertions, 1);
    assert.equal(candidateAssertions, 1);
    assert.notEqual(f.old.env.POOL_APP_SIGNING_KEY, f.candidate.env.POOL_APP_SIGNING_KEY);
    assert.ok(
      f.candidate.calls.install.some(
        (policy) => policy.pool === "retired-pool" && policy.dirty && !policy.accounts.length,
      ),
    );
    assert.equal(f.saved().schemaVersion, 2);
    assert.equal(f.saved().complete, true);
    assert.equal(
      JSON.stringify(f.saved()).includes(f.manifest.legacy.configuration.managementKey),
      false,
    );
    assert.equal(
      JSON.stringify(f.saved()).includes(f.manifest.candidate.configuration.managementKey),
      false,
    );
    const before = f.events.filter((e) =>
      ["upload", "activate", "adopt", "stage", "promote", "drain"].includes(e.action),
    ).length;
    assert.deepEqual(await f.activate(), result);
    assert.equal(
      f.events.filter((e) =>
        ["upload", "activate", "adopt", "stage", "promote", "drain"].includes(e.action),
      ).length,
      before,
    );
  } finally {
    await f.cleanup();
  }
}

async function earlyAdvance(expectSuccess = false) {
  const f = await firstHandoffFlow({ earlyAdvance: true });
  try {
    await assert.rejects(f.activate());
    const adoption = f.events.find((e) => e.action === "adopt");
    assert.ok(adoption);
    assert.equal(adoption.desired, f.candidate.target.imageInput);
    assert.equal(f.candidate.calls.start, 0);
    assert.equal(f.old.calls.destroy, 0);
    assert.equal(
      adoption.http,
      expectSuccess ? 200 : 409,
      "actual Endpoint.admit refuses early current image/config advancement",
    );
  } finally {
    await f.cleanup();
  }
}

async function blockedAdoption(options, expectedReason) {
  const f = await firstHandoffFlow(options);
  try {
    await assert.rejects(f.activate(), (error) => error.reason === expectedReason);
    assert.equal(f.desired(), f.old.target.imageInput);
    assert.equal(f.candidate.calls.start, 0);
    assert.equal(f.old.calls.destroy, 0);
    assert.equal(f.events.filter((e) => e.action === "adopt").length, 1);
    assert.equal(f.events.filter((e) => e.action === "upload").length, 1);
    await assert.rejects(f.activate());
    assert.equal(
      f.events.filter((e) => e.action === "adopt").length,
      1,
      "witness cannot substitute for a lost or invalid ACK on resume",
    );
    assert.equal(f.events.filter((e) => e.action === "upload").length, 1);
    assert.equal(f.candidate.calls.start, 0);
  } finally {
    await f.cleanup();
  }
}

async function disabled() {
  const f = await firstHandoffFlow();
  try {
    await assert.rejects(
      f.activate({ enable: undefined }),
      (error) => error.reason === "first-handoff-not-enabled",
    );
    await assert.rejects(
      f.activate({ enable: { ...f.enable, expiresAt: Date.now() - 1 } }),
      (error) => error.reason === "first-handoff-not-enabled",
    );
    await assert.rejects(
      f.activate({ lease: { id: "foreign-writer", exclusive: async (work) => work() } }),
    );
    assert.deepEqual(f.events, []);
    assert.equal(f.saved(), undefined);
    assert.equal(f.candidate.calls.start, 0);
  } finally {
    await f.cleanup();
  }
}

async function lostWrite(options, finalAction, candidateStarts) {
  const f = await firstHandoffFlow(options);
  try {
    if (options.lostStartAck) await f.activate();
    else await assert.rejects(f.activate());
    const writes = f.events.filter((e) =>
      ["upload", "activate", "adopt", "stage", "promote", "drain"].includes(e.action),
    ).length;
    if (!options.lostStartAck) assert.equal(f.events.at(-1).action, finalAction);
    assert.equal(f.candidate.calls.start, candidateStarts);
    if (options.lostStartAck) await f.activate();
    else await assert.rejects(f.activate());
    assert.equal(
      f.events.filter((e) =>
        ["upload", "activate", "adopt", "stage", "promote", "drain"].includes(e.action),
      ).length,
      writes,
    );
    assert.equal(f.candidate.calls.start, candidateStarts);
    assert.equal(f.old.calls.destroy, options.lostDrainAck || options.lostStartAck ? 1 : 0);
  } finally {
    await f.cleanup();
  }
}

async function redactedSecrets() {
  const f = await firstHandoffFlow({ redactSecrets: true });
  try {
    const receipt = await f.activate();
    assert.equal(receipt.active.bootId, f.candidate.identity().bootId);
    assert.equal(f.candidate.calls.start, 1);
  } finally {
    await f.cleanup();
  }
}

async function secretMismatch() {
  const f = await firstHandoffFlow({ redactSecrets: true, wrongRuntimeSecret: true });
  try {
    await assert.rejects(
      f.activate(),
      (error) => error.reason === "runtime-handoff-response-refused",
    );
    assert.equal(f.events.find((e) => e.action === "stage").http, 409);
    assert.equal(f.candidate.calls.start, 0);
    assert.equal(f.old.calls.destroy, 0);
  } finally {
    await f.cleanup();
  }
}

async function crashBeforeSend() {
  const f = await firstHandoffFlow({ crashBeforeCodeStage: true });
  try {
    await assert.rejects(f.activate());
    assert.deepEqual(f.events, []);
    await assert.rejects(f.activate());
    assert.deepEqual(f.events, []);
    assert.equal(f.candidate.calls.start, 0);
    assert.equal(f.old.calls.destroy, 0);
  } finally {
    await f.cleanup();
  }
}

if (process.argv.includes("--redacted-only")) await redactedSecrets();
else if (process.argv.includes("--expect-early-success")) await earlyAdvance(true);
else {
  await earlyAdvance();
  console.log("PASS actual Endpoint.admit refuses early environment advancement with HTTP409");
  await positive();
  console.log(
    "PASS actual SDK + encrypted journal + Worker/SQLite first-handoff order, retained-key traffic and completed resume",
  );
  await disabled();
  console.log("PASS absent/expired enable and wrong writer lease cause zero effects");
  for (const [options, reason] of [
    [{ lostAck: true }, "provisioning-operation-unknown"],
    [{ missingAck: true }, "first-handoff-adoption-unverified"],
    [{ refusedAck: true }, "runtime-handoff-response-refused"],
    [{ ackFault: "operation" }, "first-handoff-adoption-mismatch"],
    [{ ackFault: "boot" }, "first-handoff-adoption-mismatch"],
    [{ readbackFault: "operation" }, "first-handoff-adoption-mismatch"],
    [{ readbackFault: "boot" }, "first-handoff-adoption-mismatch"],
    [{ readbackFault: "selection" }, "first-handoff-adoption-mismatch"],
  ])
    await blockedAdoption(options, reason);
  console.log(
    "PASS lost/missing/refused ACK and operation/boot/readback drift stop before current env/start, including resume",
  );
  for (const [options, last, starts] of [
    [{ lostEnvironmentActivation: true }, "activate", 0],
    [{ lostStartAck: true }, "stage", 1],
    [{ lostPromotionAck: true }, "promote", 1],
    [{ lostDrainAck: true }, "drain", 1],
  ])
    await lostWrite(options, last, starts);
  console.log(
    "PASS uncertain env/start/promotion/drain outcomes never repeat mutations or destruction on resume",
  );
  await redactedSecrets();
  await secretMismatch();
  console.log(
    "PASS provider redacts secret values while exact startup witness still joins to the frozen private configuration",
  );
  await crashBeforeSend();
  console.log(
    "PASS crash after retained intent before provider send remains pending and never dispatches on resume",
  );
  retainFirstHandoffExecution();
}
