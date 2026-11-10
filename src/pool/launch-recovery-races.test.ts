import assert from "node:assert/strict";
import { test } from "node:test";
import { stoppedFixture } from "../../scripts/pool-tests/stopped-fixture.ts";
import { automaticBudgetKey, automaticRecoveryAuthority } from "./automatic-authority.ts";
import { RuntimeRecovery } from "./runtime-recovery.ts";
import { LaunchLedger, launchStorageKey } from "./launch-ledger.ts";
import { PoolLifecycle } from "./lifecycle.ts";
import type { AutomaticApproval } from "./recovery-approval.ts";

test("healthy internal Home boot rotation keeps its launch generation and does not start again", async () => {
  const f = await stoppedFixture();
  f.appear();
  const original = await f.ledger.inspect();
  const status = f.driver.status;
  const boot = crypto.randomUUID();
  f.driver.status = async () => ({ ...(await status()), boot_id: boot });
  assert.equal((await f.deps.lifecycle.warm()).boot_id, boot);
  const updated = await f.ledger.inspect();
  assert.equal(updated?.generation, original?.generation);
  assert.equal(updated?.operationId, original?.operationId);
  assert.equal(updated?.bootId, boot);
  assert.equal(f.state().starts, 1);
});

test("lost stopped-start result fences ordinary warm across controller reconstruction", async () => {
  const f = await stoppedFixture();
  const start = f.driver.start;
  const approval = await f.approval();
  f.driver.start = () => {
    throw new Error("lost launch result");
  };
  await assert.rejects(f.construct().run(approval), /lost launch result/);
  const retained = structuredClone(f.records.get(launchStorageKey));
  f.driver.start = start;
  await assert.rejects(f.deps.lifecycle.warm(), /launch-result-uncertain/);
  const reconstructed = new PoolLifecycle(
    f.driver,
    f.storage,
    "fixture-release",
    undefined,
    new LaunchLedger(f.storage, async () => approval.target),
  );
  await assert.rejects(reconstructed.warm(), /launch-result-uncertain/);
  assert.deepEqual(f.records.get(launchStorageKey), retained);
  assert.equal((await f.construct().run(approval)).status, "started");
  assert.equal(f.state().starts, 1);
});

test("an acknowledged boot still cannot let ordinary warm bypass an unresolved policy result", async () => {
  const f = await stoppedFixture();
  f.deps.checkPolicy = async () => {
    throw new Error("unknown native result");
  };
  await assert.rejects(f.construct().run(await f.approval()), /unknown native result/);
  assert.ok((await f.ledger.inspect())?.bootId);
  await f.driver.stop();
  await assert.rejects(f.deps.lifecycle.warm(), /launch-result-uncertain/);
  assert.equal(f.state().starts, 2);
});

test("explicit guarded manual recovery retains authority but cannot clear automatic uncertainty", async () => {
  const f = await stoppedFixture();
  const start = f.driver.start;
  f.driver.start = () => {
    throw new Error("lost launch result");
  };
  await assert.rejects(f.construct().run(await f.approval()), /lost launch result/);
  f.driver.start = start;
  let guarded = false;
  await f.deps.lifecycle.restart(async () => {
    guarded = true;
  });
  assert.equal(guarded, true);
  assert.equal(f.state().starts, 2);
  const budget = f.records.get(automaticBudgetKey) as { attempts: { status: string }[] };
  assert.equal(budget.attempts[0]!.status, "started");
});

test("existing guarded transport recovery works with optional launch tracking and the same budget", async () => {
  const f = await stoppedFixture();
  f.appear();
  const current = await f.ledger.inspect();
  assert.ok(current);
  const now = f.deps.now();
  const approval: AutomaticApproval = {
    version: 1,
    action: "restart-automatic",
    operationId: crypto.randomUUID(),
    instanceId: current.target.instanceId,
    imageHash: current.target.imageHash,
    release: "a".repeat(40),
    bootId: (await f.driver.status()).boot_id,
    at: now,
    expiresAt: now + 60_000,
    pool: "synthetic-pool",
    selection: "f".repeat(64),
    samples: [now - 120_000, now - 60_000, now].map((at) => ({
      at,
      condition: "view-transport",
      selection: "f".repeat(64),
    })),
  };
  const owner = new RuntimeRecovery(
    {
      instanceId: approval.instanceId,
      imageHash: approval.imageHash,
      release: approval.release,
      running: f.driver.running,
      status: () => f.driver.status(),
      restart: (beforeStop) => f.deps.lifecycle.restart(beforeStop),
    },
    f.storage,
    f.deps.now,
    automaticRecoveryAuthority(f.storage, approval.pool, async () => "view-transport", f.deps.now),
  );
  const receipt = await owner.run(approval);
  assert.equal(receipt.status, "ready");
  assert.notEqual(receipt.bootId, approval.bootId);
  assert.equal(f.state().starts, 2);
  assert.equal(f.state().stops, 2);
});
