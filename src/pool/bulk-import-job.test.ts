import assert from "node:assert/strict";
import { test } from "node:test";
import { BulkJob, type BulkJobDependencies } from "./model-history/bulk-job.ts";
import type { BulkDefinition, BulkGuard } from "./model-history/bulk-contract.ts";

const identity = { pool: "fixture-pool", organization: "fixture-org", owner: "fixture-owner" };
function definition(count = 2): BulkDefinition {
  return {
    job: "fixture-job",
    identity: { ...identity },
    manifestDigest: "manifest-digest",
    accountMappingDigest: "map-digest",
    accountMappings: [],
    manifest: {
      version: 1,
      source: "fixture-source",
      sourceHash: "source-hash",
      approvedManifestSha256: "approved-hash",
      accountMappingDigest: "map-digest",
      totalRows: count,
      chunks: Array.from({ length: count }, (_, index) => ({
        sha256: `chunk-${index}`,
        idsSha256: `ids-${index}`,
        rows: 1,
        bytes: 1,
      })),
    },
  };
}
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function fixture(count = 2) {
  let now = 1_000_000;
  const values = new Map<string, unknown>();
  const artifacts = new Map<string, string>();
  const sqlReceipts = new Map<number, { inserted: number; existing: number; count: number }>();
  const alarms: number[] = [];
  const calls: number[] = [];
  let admitted = true;
  let admissionCalls = 0;
  let artifactCalls = 0;
  let lostReply = false;
  let beforeCommit: (() => Promise<void>) | undefined;
  let afterCommit: (() => Promise<void>) | undefined;
  const dependencies: BulkJobDependencies = {
    storage: {
      async get<T>(key: string) {
        return structuredClone(values.get(key)) as T | undefined;
      },
      async put(key, value) {
        values.set(key, structuredClone(value));
      },
    },
    async setAlarm(at) {
      alarms.push(at);
    },
    artifacts: {
      async get(job, index) {
        artifactCalls++;
        return artifacts.get(`${job}:${index}`) ?? null;
      },
      async put(job, index, data) {
        artifactCalls++;
        artifacts.set(`${job}:${index}`, data);
      },
    },
    async validateChunk(_definition, index, data) {
      if (data !== String(index))
        throw new Error("Private fixture payload must never reach status");
    },
    async admit() {
      admissionCalls++;
      if (!admitted) throw new Error("Secret database admission details");
    },
    async commitChunk(_definition, index) {
      calls.push(index);
      await beforeCommit?.();
      const receipt = sqlReceipts.get(index) ?? { inserted: 1, existing: 0, count: 1 };
      sqlReceipts.set(index, receipt);
      await afterCommit?.();
      if (lostReply) {
        lostReply = false;
        throw new Error("Secret driver failure");
      }
      return receipt;
    },
    now: () => now,
    intervalMs: 100,
  };
  let job = new BulkJob(dependencies);
  const guard = (): BulkGuard => ({
    observedAt: now,
    expiresAt: now + 90_000,
    ready: true,
    cpu: 95,
    poolErrors: 0,
    queryErrors: 0,
  });
  return {
    get job() {
      return job;
    },
    dependencies,
    alarms,
    calls,
    sqlReceipts,
    values,
    get artifactCalls() {
      return artifactCalls;
    },
    get admissionCalls() {
      return admissionCalls;
    },
    guard,
    advance(ms: number) {
      now += ms;
    },
    admit(value: boolean) {
      admitted = value;
    },
    loseReply() {
      lostReply = true;
    },
    beforeCommit(callback: () => Promise<void>) {
      beforeCommit = callback;
    },
    afterCommit(callback: () => Promise<void>) {
      afterCommit = callback;
    },
    restart() {
      job = new BulkJob(dependencies);
      return job;
    },
    async stage() {
      const value = definition(count);
      await job.begin(value);
      for (let index = 0; index < count; index++) await job.upload(identity, index, String(index));
      await job.observe(identity, guard());
      await job.approve(identity, value.manifestDigest, value.accountMappingDigest);
    },
  };
}

test("bulk jobs bind immutable definitions, uploads and approval to their owner", async () => {
  const f = fixture();
  const value = definition();
  await f.job.begin(value);
  value.manifest.source = "mutated-caller-object";
  assert.equal((await f.job.begin(definition())).state, "uploading");
  await assert.rejects(f.job.begin(value), /immutable/);
  await assert.rejects(f.job.approve(identity, "manifest-digest", "map-digest"), /approval/);
  const wrongOwner = { ...identity, organization: "another-organization" };
  await assert.rejects(f.job.upload(wrongOwner, 0, "0"), /owner mismatch/);
  assert.equal(f.artifactCalls, 0);
  await f.job.upload(identity, 0, "0");
  await f.job.upload(identity, 0, "0");
  await assert.rejects(f.job.upload(identity, 0, "changed"));
  await f.job.upload(identity, 1, "1");
  await assert.rejects(f.job.approve(identity, "manifest-digest", "wrong-map"), /approval/);
  assert.equal((await f.job.approve(identity, "manifest-digest", "map-digest")).committedChunks, 0);
});

test("each alarm commits one chunk and a cold controller retains exact progress", async () => {
  const f = fixture();
  await f.stage();
  const guardExpiry = f.guard().expiresAt;
  await f.job.tick();
  assert.deepEqual(f.calls, [0]);
  assert.deepEqual(await f.job.status(identity), {
    job: "fixture-job",
    state: "running",
    manifestDigest: "manifest-digest",
    accountMappingDigest: "map-digest",
    totalRows: 2,
    totalChunks: 2,
    uploadedChunks: 2,
    committedChunks: 1,
    inserted: 1,
    existing: 0,
    reason: null,
  });
  f.advance(100);
  await f.restart().tick();
  assert.deepEqual(f.calls, [0, 1]);
  assert.equal((await f.job.status(identity)).state, "completed");
  assert.ok(f.alarms.every((at) => at <= guardExpiry));
});

test("lost SQL replies pause safely and receipt replay retains the original counts", async () => {
  const f = fixture(1);
  await f.stage();
  f.loseReply();
  await f.job.tick();
  assert.equal(f.sqlReceipts.size, 1);
  assert.equal((await f.job.status(identity)).reason, "commit_failed");
  assert.equal((await f.job.status(identity)).inserted, 0);
  await f.restart().observe(identity, f.guard());
  assert.equal((await f.job.status(identity)).state, "paused");
  await f.job.resume(identity);
  await f.job.tick();
  const status = await f.job.status(identity);
  assert.equal(status.state, "completed");
  assert.equal(status.inserted, 1);
  assert.equal(status.existing, 0);
  assert.deepEqual(f.calls, [0, 0]);
  assert.doesNotMatch(JSON.stringify(status), /Secret|driver/);
});

test("the recovery alarm exists before SQL starts and only one tick can be in flight", async () => {
  const f = fixture();
  await f.stage();
  const entered = deferred(),
    finish = deferred();
  const armedBeforeTick = f.alarms.length;
  f.beforeCommit(async () => {
    assert.ok(f.alarms.length > armedBeforeTick);
    entered.resolve();
    await finish.promise;
  });
  const tick = f.job.tick();
  await entered.promise;
  assert.equal(f.job.tick(), tick);
  await f.job.pause(identity);
  finish.resolve();
  await tick;
  const status = await f.job.status(identity);
  assert.equal(status.state, "paused");
  assert.equal(status.reason, "operator_paused");
  assert.equal(status.committedChunks, 1);
  await f.job.observe(identity, f.guard());
  assert.equal((await f.job.status(identity)).state, "paused");
});

test("expired or invalid guards fail closed without renewing themselves", async () => {
  const f = fixture();
  await f.stage();
  f.advance(90_000);
  await f.job.tick();
  assert.equal((await f.job.status(identity)).reason, "guard_paused");
  assert.deepEqual(f.calls, []);
  assert.equal(f.admissionCalls, 0);
  for (const invalid of [
    { cpu: NaN },
    { cpu: 101 },
    { poolErrors: -1 },
    { queryErrors: 1 },
    { ready: false },
    { expiresAt: f.guard().expiresAt + 1 },
    { observedAt: f.guard().observedAt + 1 },
  ]) {
    await f.job.observe(identity, { ...f.guard(), ...invalid });
    await f.job.tick();
    assert.equal((await f.job.status(identity)).state, "paused");
  }
  await f.job.observe(identity, f.guard());
  assert.equal((await f.job.status(identity)).state, "running");
  await f.job.tick();
  assert.equal((await f.job.status(identity)).committedChunks, 1);
});

test("admission is fresh for each chunk and a guard can expire during admission", async () => {
  const f = fixture();
  await f.stage();
  await f.job.tick();
  f.admit(false);
  await f.job.tick();
  assert.equal(f.admissionCalls, 2);
  assert.deepEqual(f.calls, [0]);
  assert.equal((await f.job.status(identity)).reason, "admission_failed");
  assert.doesNotMatch(JSON.stringify(await f.job.status(identity)), /Secret|database/);
  f.admit(true);
  await f.job.resume(identity);
  f.dependencies.admit = async () => {
    f.advance(90_000);
  };
  await f.job.tick();
  assert.deepEqual(f.calls, [0]);
  assert.equal((await f.job.status(identity)).reason, "guard_paused");
});

test("a process lost after SQL commit replays only through its atomic receipt", async () => {
  const f = fixture(1);
  await f.stage();
  const abandoned = deferred(),
    committed = deferred();
  f.afterCommit(async () => {
    committed.resolve();
    await abandoned.promise;
  });
  const oldTick = f.job.tick();
  await committed.promise;
  assert.equal(f.sqlReceipts.size, 1);
  assert.equal((await f.job.status(identity)).committedChunks, 0);
  assert.ok(f.alarms.length >= 2);
  f.afterCommit(async () => {});
  await f.restart().tick();
  assert.equal((await f.job.status(identity)).state, "completed");
  assert.equal((await f.job.status(identity)).inserted, 1);
  assert.deepEqual(f.calls, [0, 0]);
  abandoned.resolve();
  await oldTick;
});
