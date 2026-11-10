import assert from "node:assert/strict";
import { test } from "node:test";
import { stoppedFixture, barrier } from "../../scripts/pool-tests/stopped-fixture.ts";
import { automaticBudgetKey } from "./automatic-authority.ts";
import { consumeAutomaticAttempt, finishAutomaticAttempt } from "./automatic-recovery.ts";
import { LaunchLedger, launchStorageKey } from "./launch-ledger.ts";
import { StoppedRecovery } from "./stopped-recovery.ts";

test("disabled source refuses without starting or consuming authority", async () => {
  const f = await stoppedFixture();
  const state = f.state();
  await assert.rejects(f.construct(false).run(await f.approval()), /disabled/);
  assert.deepEqual(f.state(), state);
  assert.equal(f.records.has(automaticBudgetKey), false);
});

test("stopped recovery starts once, proves every policy and survives eviction without replay", async () => {
  const f = await stoppedFixture();
  const approval = await f.approval();
  const checked: string[] = [];
  const check = f.deps.checkPolicy;
  f.deps.checkPolicy = async (policy, signal) => {
    checked.push(policy.pool);
    await check(policy, signal);
  };
  const receipt = await f.construct().run(approval);
  assert.equal(receipt.status, "ready");
  assert.equal(receipt.generation, 2);
  assert.deepEqual(checked.sort(), ["one", "two"]);
  assert.deepEqual(f.state(), { starts: 2, stops: 1, running: true, elapsed: 0 });
  assert.deepEqual(await f.construct().run(approval), receipt);
  assert.equal(f.state().starts, 2);
  const inspected = JSON.stringify(await f.construct().inspect(approval.operationId));
  const record = await f.ledger.current();
  assert.ok(record);
  assert.equal(inspected.includes(record.token), false);
  assert.equal(
    (await new LaunchLedger(f.storage, async () => approval.target).inspect())?.generation,
    2,
  );
});

for (const property of [
  "controllerId",
  "instanceId",
  "applicationId",
  "versionId",
  "imageHash",
  "imageDigest",
  "releaseEpoch",
] as const) {
  test(`exact ${property} drift refuses before start`, async () => {
    const f = await stoppedFixture();
    const approval = await f.approval();
    f.drift({
      [property]:
        property.endsWith("Id") && property !== "controllerId" && property !== "instanceId"
          ? "changed-id"
          : (property === "imageDigest" ? "sha256:" : "") + "f".repeat(64),
    });
    await assert.rejects(f.construct().run(approval), /target-drift/);
    assert.equal(f.state().starts, 1);
    assert.equal(f.records.has(automaticBudgetKey), false);
  });
}

test("missing generation and a historical boot alone never authorize a launch", async () => {
  const f = await stoppedFixture();
  const approval = await f.approval();
  f.records.delete(launchStorageKey);
  await assert.rejects(f.construct().run(approval), /generation-drift/);
  assert.equal(f.state().starts, 1);
});

test("a normal warm or manual recovery already queued wins over a stopped approval", async () => {
  for (const kind of ["warm", "restart"] as const) {
    const f = await stoppedFixture();
    const approval = await f.approval();
    const entered = barrier(),
      release = barrier();
    // This test exercises the real lifecycle queue. The unrelated start has its own authority.
    const status = f.driver.status;
    f.driver.status = async () => {
      entered.resolve();
      await release.promise;
      return status();
    };
    const pending = kind === "warm" ? f.deps.lifecycle.warm() : f.deps.lifecycle.restart();
    await entered.promise;
    const recovery = f.construct().run(approval);
    release.resolve();
    await pending;
    await assert.rejects(recovery, /no-longer-stopped/);
    assert.equal(f.records.has(automaticBudgetKey), false);
  }
});

test("process appearance during durable preparation never reaches destroy or start", async () => {
  const f = await stoppedFixture();
  const approval = await f.approval();
  const put = f.storage.put;
  f.storage.put = async (key, value) => {
    await put(key, value);
    if (key === launchStorageKey) f.appear();
  };
  await assert.rejects(f.construct().run(approval), /no-longer-stopped/);
  assert.equal(f.state().starts, 1);
  assert.equal(f.state().stops, 1);
  assert.equal((await f.construct().inspect(approval.operationId)).receipt?.status, "started");
});

test("unknown launch result persists started and blocks both recovery kinds", async () => {
  const f = await stoppedFixture();
  const approval = await f.approval();
  f.driver.start = () => {
    throw new Error("lost launch response");
  };
  await assert.rejects(f.construct().run(approval), /lost launch response/);
  assert.equal((await f.construct().run(approval)).status, "started");
  f.advance(31 * 60_000);
  await assert.rejects(f.construct().run(await f.approval()), /no-trusted-previous-boot/);
  assert.throws(
    () =>
      consumeAutomaticAttempt(
        f.records.get(automaticBudgetKey),
        { operationId: crypto.randomUUID(), instanceId: approval.target.instanceId },
        10_000_000,
      ),
    /uncertain/,
  );
  assert.equal(f.state().starts, 1);
});

test("view recovery and stopped recovery share the unchanged durable cooldown", async () => {
  const f = await stoppedFixture();
  const approval = await f.approval();
  const state = consumeAutomaticAttempt(
    undefined,
    { operationId: crypto.randomUUID(), instanceId: approval.target.instanceId },
    999_999,
  );
  f.records.set(
    automaticBudgetKey,
    finishAutomaticAttempt(state, state.attempts[0]!.operationId, "ready"),
  );
  await assert.rejects(f.construct().run(approval), /cooldown/);
  assert.equal(f.state().starts, 1);
});

test("a post-start policy refusal never returns ready or retries the same operation", async () => {
  const f = await stoppedFixture();
  const approval = await f.approval();
  f.deps.checkPolicy = async () => {
    throw new Error("native policy400");
  };
  await assert.rejects(f.construct().run(approval), /policy400/);
  assert.equal((await f.construct().run(approval)).status, "started");
  assert.equal(f.state().starts, 2);
  assert.equal(f.state().stops, 1);
});

test("default service construction remains disabled", async () => {
  const f = await stoppedFixture();
  await assert.rejects(new StoppedRecovery(f.deps).run(await f.approval()), /disabled/);
});

test("expiry during durable launch preparation cannot start the container", async () => {
  const f = await stoppedFixture();
  const approval = await f.approval();
  const put = f.storage.put;
  f.storage.put = async (key, value) => {
    await put(key, value);
    if (key === launchStorageKey) f.advance(60_001);
  };
  await assert.rejects(f.construct().run(approval), /approval-expired/);
  assert.equal(f.state().starts, 1);
  assert.equal((await f.construct().inspect(approval.operationId)).receipt?.status, "started");
});
