import assert from "node:assert/strict";
import { test } from "node:test";
import { stoppedFixture } from "../../scripts/pool-tests/stopped-fixture.ts";
import {
  readRuntimeHealth,
  launchGenerationHeader,
  launchTokenHashHeader,
  policyHealthHeader,
} from "./runtime-health.ts";
import { poolLifecycle, PoolLifecycle } from "./lifecycle.ts";
import { launchStorageKey } from "./launch-ledger.ts";

test("authenticated readiness parses only a complete valid launch proof and never extends the health lease", async () => {
  for (const [generation, hash, accepted] of [
    ["1", "a".repeat(64), true],
    ["01", "a".repeat(64), false],
    ["9007199254740992", "a".repeat(64), false],
    ["1", "missing", false],
    ["", "a".repeat(64), false],
  ] as const) {
    const status = await readRuntimeHealth(
      {
        fetch: async (_url, init) => {
          assert.equal(new Headers(init.headers).get("Authorization"), "Bearer fixture");
          return Response.json(
            { boot_id: "boot", started_at: "2026-11-09T00:00:00Z" },
            {
              headers: {
                [launchGenerationHeader]: generation,
                [launchTokenHashHeader]: hash,
                [policyHealthHeader]: "1000",
              },
            },
          );
        },
      },
      "fixture",
      new AbortController().signal,
      () => 500,
    );
    assert.equal(status.launch !== undefined, accepted);
    assert.equal(status.policyLeaseUntil, 1_500);
  }
});

test("wrong launch token cannot complete readiness or trigger a second start", async () => {
  const f = await stoppedFixture();
  const approval = await f.approval();
  const status = f.driver.status;
  f.driver.status = async () => ({
    ...(await status()),
    launch: { generation: 2, tokenHash: "f".repeat(64) },
  });
  await assert.rejects(f.construct().run(approval), /startup budget/);
  assert.equal(f.state().elapsed, poolLifecycle.startupTimeoutMs);
  assert.equal(f.state().starts, 2);
  assert.equal((await f.construct().run(approval)).status, "started");
});

test("a changed boot or expired health after policy proof consumes a failed attempt", async () => {
  for (const change of ["boot", "health"] as const) {
    const f = await stoppedFixture();
    const status = f.deps.status;
    f.deps.status = async () => ({
      ...(await status()),
      ...(change === "boot" ? { boot_id: crypto.randomUUID() } : { policyLeaseUntil: 1 }),
    });
    const result = await f.construct().run(await f.approval());
    assert.equal(result.status, "failed");
    assert.equal(f.state().starts, 2);
    assert.equal(f.state().stops, 1);
  }
});

test("policy expiry while final health is read cannot produce a ready receipt", async () => {
  const f = await stoppedFixture();
  const status = f.deps.status;
  f.deps.status = async () => {
    f.advance(20_000);
    return status();
  };
  const approval = await f.approval();
  await assert.rejects(f.construct().run(approval), /policies are not acknowledged/);
  assert.equal((await f.construct().run(approval)).status, "started");
});

test("membership readers cannot pass completion until its ready receipt is persisted", async () => {
  const f = await stoppedFixture();
  const approval = await f.approval();
  let observer: Promise<void> | undefined;
  const status = f.deps.status;
  f.deps.status = async () => {
    observer = f.memberships.authority("one").then(() => {
      assert.equal(
        (f.records.get(`runtime-recovery-v1:${approval.operationId}`) as { status: string }).status,
        "ready",
      );
    });
    return status();
  };
  assert.equal((await f.construct().run(approval)).status, "ready");
  await observer;
});

test("legacy lifecycle operation ignores additive launch state without changing or consuming it", async () => {
  const f = await stoppedFixture();
  const retained = structuredClone(f.records.get(launchStorageKey));
  f.appear();
  f.drift({ releaseEpoch: "f".repeat(64) });
  const old = new PoolLifecycle(f.driver, f.storage, "fixture-release");
  assert.ok((await old.warm()).boot_id);
  assert.deepEqual(f.records.get(launchStorageKey), retained);
  assert.equal(f.state().starts, 1);
  assert.equal(f.state().stops, 1);
});
