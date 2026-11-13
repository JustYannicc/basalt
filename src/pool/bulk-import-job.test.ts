import assert from "node:assert/strict";
import { test } from "node:test";
import { BulkJob, type BulkJobDependencies } from "./model-history/bulk-job.ts";
import type { BulkDefinition, BulkGuard } from "./model-history/bulk-contract.ts";

const identity = { pool: "fixture-pool", organization: "fixture-org", owner: "fixture-owner" };
function definition(count = 2, rows = 1): BulkDefinition {
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
      totalRows: count * rows,
      chunks: Array.from({ length: count }, (_, index) => ({
        sha256: `chunk-${index}`,
        idsSha256: `ids-${index}`,
        rows,
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
function fixture(count = 2, rows = 1) {
  let now = 1_000_000;
  const values = new Map<string, unknown>();
  const artifacts = new Map<string, string>();
  const sqlReceipts = new Map<string, { inserted: number; existing: number; count: number }>();
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
    async commitChunk(_definition, index, _data, start = 0, size = rows) {
      calls.push(index);
      await beforeCommit?.();
      const receipt = sqlReceipts.get(`${index}:${start}`) ?? {
        inserted: size,
        existing: 0,
        count: size,
      };
      sqlReceipts.set(`${index}:${start}`, receipt);
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
    cpu: 50,
    cpuAt: now,
    releaseReadComplete: true,
    releaseWindowActive: false,
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
      const value = definition(count, rows);
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
    chunkSize: 500,
    rateRowsPerSecond: 1000 / 501,
    nextBatchAt: 1_000_500,
    requiresAttention: false,
    serving: {
      source: null,
      kind: null,
      status: "not available",
      baseline: null,
      thresholds: [],
      window: null,
      observedAt: null,
      computedAt: null,
      regressionAt: null,
      consecutiveRegressions: 0,
    },
  });
  f.advance(1000);
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
  assert.equal((await f.job.status(identity)).reason, "database_error");
  assert.equal((await f.job.status(identity)).inserted, 0);
  await f.restart().observe(identity, f.guard());
  assert.equal((await f.job.status(identity)).state, "stopped");
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
  f.advance(1000);
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

test("adaptive import throttles at max load, resumes below the low watermark and pauses releases", async () => {
  const f = fixture();
  await f.stage();
  await f.job.observe(identity, { ...f.guard(), cpu: 70 });
  await f.job.tick();
  assert.equal((await f.job.status(identity)).reason, "cpu_high");
  assert.deepEqual(f.calls, []);
  await f.job.observe(identity, { ...f.guard(), cpu: 65 });
  assert.equal((await f.job.status(identity)).state, "paused");
  await f.job.observe(identity, { ...f.guard(), cpu: 59 });
  assert.equal((await f.job.status(identity)).state, "running");
  await f.job.tick();
  assert.deepEqual(f.calls, [0]);
  await f.job.observe(identity, { ...f.guard(), ready: false, releaseWindowActive: true });
  assert.equal((await f.job.status(identity)).reason, "release_backup");
  f.advance(1000);
  await f.job.tick();
  assert.deepEqual(f.calls, [0]);
  await f.job.observe(identity, f.guard());
  await f.job.tick();
  assert.deepEqual(f.calls, [0, 1]);
});

test("sustained critical CPU and DB errors stop durably and never auto-resume", async () => {
  const f = fixture();
  await f.stage();
  for (let sample = 0; sample < 3; sample++) {
    if (sample) f.advance(60_000);
    await f.job.observe(identity, { ...f.guard(), cpu: 90 });
  }
  const stopped = await f.job.status(identity);
  assert.equal(stopped.state, "stopped");
  assert.equal(stopped.reason, "critical_cpu");
  assert.equal(stopped.requiresAttention, true);
  await f.restart().observe(identity, f.guard());
  await f.job.tick();
  assert.equal((await f.job.status(identity)).state, "stopped");
  assert.deepEqual(f.calls, []);
  await f.job.resume(identity);
  await f.job.observe(identity, { ...f.guard(), queryErrors: 1, ready: false });
  assert.equal((await f.job.status(identity)).state, "stopped");
  assert.equal((await f.job.status(identity)).reason, "database_error");
});

test("adaptive SQL batches resize toward chunk time and retain pacing across restart", async () => {
  const f = fixture(1, 5000);
  await f.stage();
  f.beforeCommit(async () => f.advance(250));
  await f.job.tick();
  let status = await f.job.status(identity);
  assert.equal(status.inserted, 500);
  assert.equal(status.committedChunks, 0);
  assert.equal(status.chunkSize, 1000);
  assert.ok(status.rateRowsPerSecond > 0);
  await f.restart().tick();
  assert.equal((await f.job.status(identity)).inserted, 500);
  f.advance(1000);
  await f.job.observe(identity, f.guard());
  f.beforeCommit(async () => f.advance(1000));
  await f.job.tick();
  status = await f.job.status(identity);
  assert.equal(status.inserted, 1500);
  assert.equal(status.chunkSize, 500);
  assert.ok(status.nextBatchAt > f.guard().observedAt);
});

function serving(now: number, baselineTo: number, p99Ms = 100, serverErrors = 0) {
  const row = {
    route: "/v1/responses",
    streamMode: "stream" as const,
    successful: 100,
    failures: serverErrors,
    serverErrors,
    total: 100 + serverErrors,
    p99Ms,
  };
  return {
    source: "fixture-model-completions-v1",
    kind: "model-completion" as const,
    available: true,
    observedAt: now,
    computedAt: now,
    baseline: {
      from: baselineTo - 300_000,
      to: baselineTo,
      nonRelease: true as const,
      routes: [{ ...row, failures: 0, serverErrors: 0, total: 100, p99Ms: 100 }],
    },
    window: { from: now - 300_000, to: now, routes: [row] },
  };
}
test("no serving source runs on CPU guards and reports not available", async () => {
  const f = fixture();
  await f.stage();
  await f.job.tick();
  assert.deepEqual(f.calls, [0]);
  assert.equal((await f.job.status(identity)).serving.status, "not available");
});
test("configured serving telemetry binds frozen thresholds, yields and resumes only on a fresh healthy signal", async () => {
  const f = fixture(4);
  const baselineTo = f.guard().observedAt - 1;
  await f.stage();
  const observe = (p99 = 100, errors = 0) =>
    f.job.observe(identity, {
      ...f.guard(),
      serving: serving(f.guard().observedAt, baselineTo, p99, errors),
    });
  await observe(250);
  assert.equal((await f.job.status(identity)).state, "running");
  f.advance(60_000);
  await observe(250);
  assert.equal((await f.job.status(identity)).reason, "serving_regressed");
  const frozen = (await f.job.status(identity)).serving.thresholds;
  assert.equal(frozen[0]!.maximumP99Ms, 200);
  assert.equal(frozen[0]!.successful, 100);
  const inflated = serving(f.guard().observedAt, baselineTo, 250);
  inflated.baseline.routes[0]!.p99Ms = 1000;
  await f.job.observe(identity, { ...f.guard(), serving: inflated });
  assert.deepEqual((await f.job.status(identity)).serving.thresholds, frozen);
  const stale = serving(f.guard().observedAt, baselineTo);
  f.advance(121_000);
  await f.job.observe(identity, { ...f.guard(), serving: stale });
  assert.equal((await f.job.status(identity)).reason, "serving_stale");
  await f.restart().observe(identity, f.guard());
  assert.equal((await f.job.status(identity)).reason, "serving_stale");
  await observe();
  assert.equal((await f.job.status(identity)).state, "running");
  f.advance(60_000);
  await observe(100, 1);
  assert.equal((await f.job.status(identity)).reason, "serving_regressed");
  assert.equal((await f.job.status(identity)).serving.consecutiveRegressions, 1);
});

test("serving gaps break consecutive regressions and reused computations cannot resume", async () => {
  const f = fixture();
  await f.stage();
  const baselineTo = f.guard().observedAt - 1;
  const observe = (signal: ReturnType<typeof serving>) =>
    f.job.observe(identity, { ...f.guard(), serving: signal });
  await observe(serving(f.guard().observedAt, baselineTo, 250));
  f.advance(60_000);
  const failed = serving(f.guard().observedAt, baselineTo);
  failed.available = false;
  await observe(failed);
  assert.equal((await f.job.status(identity)).reason, "serving_unavailable");
  assert.equal((await f.job.status(identity)).serving.consecutiveRegressions, 0);
  f.advance(60_000);
  await observe(serving(f.guard().observedAt, baselineTo, 250));
  assert.equal((await f.job.status(identity)).state, "running");
  f.advance(60_000);
  await observe(serving(f.guard().observedAt, baselineTo, 250));
  assert.equal((await f.job.status(identity)).reason, "serving_regressed");
  await observe(serving(f.guard().observedAt, baselineTo));
  assert.equal((await f.job.status(identity)).reason, "serving_stale");
  f.advance(60_000);
  await observe(serving(f.guard().observedAt, baselineTo));
  assert.equal((await f.job.status(identity)).state, "running");
});

test("sparse dependency telemetry stays labeled and a zero-baseline server error yields immediately", async () => {
  const f = fixture();
  await f.stage();
  const signal = serving(f.guard().observedAt, f.guard().observedAt - 1);
  const dependency = {
    ...signal,
    source: "fixture-membership-completions-v1",
    kind: "serving-dependency" as const,
  };
  dependency.baseline.routes[0]!.successful = 20;
  dependency.baseline.routes[0]!.total = 20;
  dependency.window.routes[0]!.successful = 3;
  dependency.window.routes[0]!.total = 3;
  await f.job.observe(identity, { ...f.guard(), serving: dependency });
  assert.equal((await f.job.status(identity)).reason, "serving_unavailable");
  assert.equal((await f.job.status(identity)).serving.kind, "serving-dependency");
  assert.equal((await f.job.status(identity)).serving.thresholds[0]!.sampleQuality, "noisy");
  f.advance(60_000);
  dependency.computedAt = dependency.observedAt = dependency.window.to = f.guard().observedAt;
  dependency.window.from = dependency.window.to - 300_000;
  dependency.window.routes[0]!.failures = 1;
  dependency.window.routes[0]!.serverErrors = 1;
  dependency.window.routes[0]!.total = 4;
  await f.job.observe(identity, { ...f.guard(), serving: dependency });
  assert.equal((await f.job.status(identity)).reason, "serving_regressed");
  f.advance(60_000);
  await f.job.observe(identity, f.guard());
  assert.equal((await f.job.status(identity)).reason, "serving_stale");
});
