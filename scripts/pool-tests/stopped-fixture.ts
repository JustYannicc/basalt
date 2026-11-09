import assert from "node:assert/strict";
import { automaticBudgetKey } from "../../src/pool/automatic-authority.ts";
import { LaunchLedger, launchTokenHash } from "../../src/pool/launch-ledger.ts";
import type { LaunchRecord, LaunchTarget } from "../../src/pool/launch-contract.ts";
import { PoolLifecycle } from "../../src/pool/lifecycle.ts";
import { NativeMemberships } from "../../src/pool/membership.ts";
import type { NativeMembershipPolicy } from "../../src/pool/membership-contract.ts";
import { StoppedRecovery, type StoppedReceipt } from "../../src/pool/stopped-recovery.ts";
import { stoppedSelection, type StoppedApproval } from "../../src/pool/stopped-approval.ts";

export function barrier() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

export async function stoppedFixture(
  options: { install?: (policy: NativeMembershipPolicy) => Promise<void> } = {},
) {
  let now = 1_000_000;
  let elapsed = 0;
  let running = false;
  let starts = 0;
  let stops = 0;
  let boot = crypto.randomUUID();
  let launch: LaunchRecord | undefined;
  const expectedOperations = new Set<string>();
  let target: LaunchTarget = {
    controllerId: "a".repeat(64),
    instanceId: "b".repeat(64),
    applicationId: "application-fixture",
    versionId: "version-fixture",
    imageHash: "c".repeat(64),
    imageDigest: "sha256:" + "c".repeat(64),
    releaseEpoch: "d".repeat(64),
  };
  const records = new Map<string, unknown>();
  const storage = {
    get: async <T>(key: string) => structuredClone(records.get(key)) as T | undefined,
    put: async (key: string, value: unknown) => {
      records.set(key, structuredClone(value));
    },
    getAlarm: async () => null,
    setAlarm: async () => {},
  };
  const ledger = new LaunchLedger(storage, async () => target);
  const installed = new Map<string, NativeMembershipPolicy>();
  const driver = {
    running: () => running,
    start(record?: LaunchRecord) {
      assert.ok(record);
      // An automatic launch may happen only after both durable uncertainty markers exist.
      if (expectedOperations.has(record.operationId)) {
        const receipt = records.get(`runtime-recovery-v1:${record.operationId}`) as StoppedReceipt;
        assert.equal(receipt.status, "started");
        assert.equal(
          (records.get(automaticBudgetKey) as { attempts: { status: string }[] }).attempts.at(-1)
            ?.status,
          "started",
        );
      }
      starts++;
      running = true;
      boot = crypto.randomUUID();
      launch = record;
      installed.clear();
    },
    async stop() {
      stops++;
      running = false;
    },
    async keepAlive() {},
    async status() {
      assert.ok(launch);
      return {
        boot_id: boot,
        started_at: "2026-11-09T00:00:00Z",
        policyLeaseUntil: performance.now() + 1_500,
        launch: { generation: launch.generation, tokenHash: await launchTokenHash(launch.token) },
      };
    },
  };
  const lifecycle = new PoolLifecycle(
    driver,
    storage,
    "fixture-release",
    {
      now: () => elapsed,
      sleep: async (ms) => {
        elapsed += ms;
      },
    },
    ledger,
  );
  const memberships = new NativeMemberships({
    storage,
    signingKey: "e".repeat(64),
    now: () => now,
    read: async (pool, organization) => ({ pool, organization, native: true, accounts: [] }),
    reconcile: async () => {},
    actual: async () => [],
    install: async (policy) => {
      await options.install?.(policy);
      installed.set(policy.pool, structuredClone(policy));
    },
    abort() {},
    schedule: async () => {},
  });
  await lifecycle.warm();
  await memberships.ensure("one", "organization");
  await memberships.ensure("two", "organization");
  await driver.stop();
  const deps = {
    storage,
    ledger,
    lifecycle,
    running: driver.running,
    status: () => driver.status(),
    memberships,
    observeStopped: async () => ({
      target,
      generation: (await ledger.current())!.generation,
      state: "stopped",
      observedAt: now,
    }),
    restorePolicies: () => memberships.tick(),
    async checkPolicy(policy: NativeMembershipPolicy, _signal: AbortSignal) {
      assert.deepEqual(installed.get(policy.pool), policy);
    },
    now: () => now,
  };
  const construct = (enabled = true) => new StoppedRecovery(deps, enabled);
  const approval = async (): Promise<StoppedApproval> => {
    const current = await ledger.inspect();
    assert.ok(current);
    const selection = await stoppedSelection(target, current.generation);
    const operationId = crypto.randomUUID();
    expectedOperations.add(operationId);
    return {
      version: 1,
      action: "start-stopped",
      operationId,
      target: structuredClone(target),
      generation: current.generation,
      selection,
      at: now,
      expiresAt: now + 60_000,
      samples: [now - 120_000, now - 60_000, now].map((at) => ({
        at,
        selection,
        condition: "stopped",
      })),
    };
  };
  return {
    construct,
    deps,
    approval,
    driver,
    ledger,
    storage,
    records,
    memberships,
    installed,
    state: () => ({ starts, stops, running, elapsed }),
    advance: (ms: number) => {
      now += ms;
    },
    drift: (change: Partial<LaunchTarget>) => {
      target = { ...target, ...change };
    },
    appear: () => {
      running = true;
    },
  };
}
