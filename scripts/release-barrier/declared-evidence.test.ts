import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { releaseEvidence } from "./evidence.ts";
import { openRecovery } from "./recovery-envelope.ts";
import { declaredRecoveryDigest } from "./declared-evidence.ts";
import type { PreparedBucket } from "./declared-buckets.ts";

const candidate = "a".repeat(40);
const key = "b".repeat(64);
const bucket: PreparedBucket = {
  fqn: "DriveRecords",
  declaration: "c".repeat(64),
  entry: "d".repeat(64),
  target: {
    accountId: "private-account",
    bucketName: "private-bucket",
    jurisdiction: "eu",
    storageClass: "Standard",
  },
  native: {
    status: "creating",
    fqn: "DriveRecords",
    logicalId: "DriveRecords",
    instanceId: "e".repeat(32),
    namespace: undefined,
    downstream: [],
    props: {},
    bindings: [],
    providerVersion: 1,
    resourceType: "Cloudflare.R2.Bucket",
    removalPolicy: "retain",
    providerMode: "live",
  },
  initialLifecycle: "absent",
  resume: false,
};

test("declared progress retains exact authenticated recovery identity and truthful public lifecycle", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "declared-evidence-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const evidence = releaseEvidence(root, candidate, key);
  await evidence.declared({ bucket, lifecycle: "planned", outcome: "not-started" });
  const planned = JSON.parse(await readFile(join(root, "declared-changes.json"), "utf8"));
  assert.equal(planned.resources[0].lifecycle, "planned");
  assert.equal(planned.resources[0].outcome, "not-started");
  const sealed = JSON.parse(await readFile(join(root, "declared-recovery.sealed.json"), "utf8"));
  const recovery = openRecovery(
    sealed,
    key,
    candidate,
    declaredRecoveryDigest(candidate, bucket.declaration),
  );
  assert.deepEqual(recovery, {
    schemaVersion: 1,
    purpose: "declared-changes",
    candidate,
    declaration: bucket.declaration,
    resources: [
      {
        fqn: bucket.fqn,
        entry: bucket.entry,
        target: bucket.target,
        native: JSON.parse(JSON.stringify(bucket.native)),
        initialLifecycle: "absent",
        resume: false,
      },
    ],
  });
  assert.throws(
    () => openRecovery(sealed, key, candidate, "f".repeat(64)),
    /authentication-failed/,
  );
  await evidence.declaredReadiness({
    declaration: bucket.declaration,
    phase: "before-upload",
    resources: [
      {
        fqn: bucket.fqn,
        type: "Cloudflare.R2.Bucket",
        entry: bucket.entry,
        ready: false,
        lifecycle: "absent",
      },
    ],
  });
  assert.equal(
    JSON.parse(await readFile(join(root, "declared-readiness.json"), "utf8")).resources[0].ready,
    false,
  );
  await evidence.declared({ bucket, lifecycle: "creating", outcome: "unknown" });
  assert.equal(
    JSON.parse(await readFile(join(root, "declared-changes.json"), "utf8")).resources[0].outcome,
    "unknown",
  );
  for (const file of await readdir(root)) {
    const text = await readFile(join(root, file), "utf8");
    assert.ok(!text.includes("private-account"));
    assert.ok(!text.includes("private-bucket"));
    assert.ok(!text.includes(bucket.native.instanceId));
  }
});

test("recovery evidence failure prevents a creation intent from being published", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "declared-no-key-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  await assert.rejects(
    releaseEvidence(root, candidate).declared({
      bucket,
      lifecycle: "planned",
      outcome: "not-started",
    }),
    /key-invalid/,
  );
  assert.deepEqual(await readdir(root), []);
});

test("success and later failure summaries distinguish retained creation from Worker activation", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "declared-summary-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const evidence = releaseEvidence(root, candidate, key);
  await evidence.declared({ bucket, lifecycle: "created", outcome: "confirmed" });
  const summary = join(root, "step-summary.md");
  await evidence.summary(summary, "failed");
  const failed = await readFile(summary, "utf8");
  assert.ok(failed.includes("failed"));
  assert.ok(failed.includes("DriveRecords"));
  assert.ok(failed.includes("confirmed"));
  assert.ok(failed.includes("Activated Worker versions: 0"));
  assert.ok(failed.includes("Retain data, native row and recovery descriptor"));
  assert.ok(!failed.includes("private-account"));
  assert.ok(!failed.includes("private-bucket"));
  await evidence.record({
    schemaVersion: 1,
    candidate,
    manifest: "a".repeat(64),
    ceilingMs: 750,
    phase: "complete",
    accepted: [{ worker: "AppData", versionId: "accepted", startupTimeMs: 100 }],
    activated: [{ worker: "AppData", versionId: "accepted" }],
  });
  await evidence.summary(summary, "complete");
  const completed = await readFile(summary, "utf8");
  assert.ok(completed.includes("complete"));
  assert.ok(completed.includes("Activated Worker versions: 1 (AppData@accepted)"));
});
