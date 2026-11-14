import assert from "node:assert/strict";
import { test } from "node:test";
import { Schema } from "effect";
import { handoffWorker } from "../../scripts/pool-tests/runtime-handoff-worker.ts";
import { openEnvelope } from "./token.ts";
import { policyHeader, policyUsePrefix } from "./membership-contract.ts";

type Fixture = Awaited<ReturnType<typeof handoffWorker>>;
async function promote(f: Fixture) {
  const grant = await f.startGrant();
  const staged = await f.command("stage", { proof: grant.envelope });
  assert.equal(staged.status, 200, await staged.clone().text());
  const joined = await f.joined(grant),
    intent = await f.intent();
  const promoted = await f.command("promote", { proof: joined.envelope, intent });
  assert.equal(promoted.status, 200, await promoted.clone().text());
  assert.equal(
    ((await promoted.json()) as { result: { status: string } }).result.status,
    "promoted",
  );
}

test("selected readiness joins the actual provider instance and boot after sibling promotion", async (context) => {
  const f = await handoffWorker();
  context.after(f.cleanup);
  await promote(f);
  const ready = await f.worker.deploymentReady(),
    provider = f.candidate.identity();
  assert.notEqual(provider.instanceId, f.old.identity().instanceId);
  assert.equal(ready.instanceId, provider.instanceId);
  assert.equal(ready.bootId, provider.bootId);
  const observation = await f.worker.availabilityProbe(f.claims.pool, true);
  assert.equal(observation.runtime?.source, "selected");
  assert.equal(observation.runtime?.applicationVersion, provider.applicationVersion);
  assert.equal(observation.runtime?.bootId, provider.bootId);
  assert.equal(observation.runtime?.expectedBootId, provider.bootId);
});

test("reconstructing the production controller for only passive reads never renews the adopted boot or writes state", async (context) => {
  const f = await handoffWorker();
  context.after(f.cleanup);
  const before = f.old.calls.keepAlive;
  let writes = 0;
  f.old.storage.afterCommit = (keys) => {
    writes += keys.length;
  };
  const worker = f.reconstruct();
  assert.equal(f.old.calls.keepAlive, before);
  assert.deepEqual(await worker.availabilityProbe(f.claims.pool), { ok: true, failures: [] });
  assert.equal((await f.command("inspect")).status, 200);
  assert.equal(f.old.calls.keepAlive, before);
  assert.equal(writes, 0);
  assert.equal(f.old.calls.start, 0);
  assert.equal(f.old.calls.destroy, 0);
});

test("same-Worker current signing key rotation keeps the old capsule key independent and promotes the new capsule key", async (context) => {
  const f = await handoffWorker({ rotateSigningKey: true });
  context.after(f.cleanup);
  assert.notEqual(f.old.env.POOL_APP_SIGNING_KEY, f.candidate.env.POOL_APP_SIGNING_KEY);
  let oldAssertions = 0,
    newAssertions = 0;
  f.old.hooks.model = async (request) => {
    const claims = await openEnvelope(
      f.old.env.POOL_APP_SIGNING_KEY,
      policyUsePrefix,
      request.headers.get(policyHeader)!,
    );
    assert.equal(
      Schema.decodeUnknownSync(Schema.Struct({ pool: Schema.String }))(claims).pool,
      f.claims.pool,
    );
    oldAssertions++;
    return undefined;
  };
  f.candidate.hooks.model = async (request) => {
    const claims = await openEnvelope(
      f.candidate.env.POOL_APP_SIGNING_KEY,
      policyUsePrefix,
      request.headers.get(policyHeader)!,
    );
    assert.equal(
      Schema.decodeUnknownSync(Schema.Struct({ pool: Schema.String }))(claims).pool,
      f.claims.pool,
    );
    newAssertions++;
    return undefined;
  };
  const before = await f.model();
  assert.equal(before.status, 200);
  await before.body?.cancel();
  await promote(f);
  const ready = await f.worker.deploymentReady();
  assert.equal(ready.bootId, f.candidate.identity().bootId);
  const after = await f.model();
  assert.equal(after.status, 200);
  await after.body?.cancel();
  assert.equal(oldAssertions, 1);
  assert.equal(newAssertions, 1);
});
