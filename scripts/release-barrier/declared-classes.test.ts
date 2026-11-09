import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { releaseEvidence } from "./evidence.ts";
import { Effect } from "effect";
import { classProvisioning } from "./test/declared-class-fixture.ts";

test("refused admission leaves only an empty additive class; rerunning never duplicates expansion or creates a bucket", async () => {
  const proof = classProvisioning({ reject: true, rerun: true });
  await Effect.runPromise(proof.effect);
  assert.equal(proof.events.filter((event) => event === "expand").length, 1);
  assert.equal(proof.events.filter((event) => event === "upload").length, 2);
  assert.ok(proof.events.indexOf("expand") < proof.events.indexOf("upload"));
  assert.ok(!proof.events.includes("create-bucket"));
  assert.ok(!proof.events.includes("activate"));
  assert.equal(proof.failures.length, 2);
  assert.equal(
    proof.emptyClassSource(),
    "import { DurableObject } from 'cloudflare:workers';\nexport class DriveObject extends DurableObject {}\n",
  );
});

test("an acknowledged expansion resumes by observation after a failed read, without another deployment", async () => {
  const proof = classProvisioning({
    failObservationOnce: true,
    rerun: true,
    expectedFailure: /release-operation-failed/,
  });
  await Effect.runPromise(proof.effect);
  assert.equal(proof.failures.length, 1);
  assert.deepEqual(proof.events, ["expand", "upload", "create-bucket", "activate"]);
});

test("an applied expansion with a lost response never retries and cannot invent its missing startup evidence", async () => {
  const proof = classProvisioning({
    loseReply: true,
    rerun: true,
    expectedFailure: /release-operation-failed/,
  });
  await Effect.runPromise(proof.effect);
  assert.equal(proof.failures.length, 2);
  assert.match(String(proof.failures[1]), /post-deployment-startup-refused/);
  assert.deepEqual(proof.events, ["expand"]);
});

test("a foreign expansion marker cannot be adopted after a lost response", async () => {
  const proof = classProvisioning({
    loseReply: true,
    foreignMarker: true,
    rerun: true,
    expectedFailure: /release-operation-failed/,
  });
  await Effect.runPromise(proof.effect);
  assert.match(String(proof.failures[1]), /expansion-unattributable/);
  assert.deepEqual(proof.events, ["expand"]);
});

test("a too-slow expansion reports post-deployment evidence and stops before candidate admission", async () => {
  const proof = classProvisioning({
    startupTimeMs: 751,
    expectedFailure: /post-deployment-startup-refused/,
  });
  await Effect.runPromise(proof.effect);
  assert.deepEqual(proof.events, ["expand"]);
  assert.ok(
    proof.progress.some((item) => item.outcome === "acknowledged" && item.startupTimeMs === 751),
  );
});

test("a declaration cannot authorize deletion alongside its new SQLite class", async () => {
  const proof = classProvisioning({ deletedClass: true, expectedFailure: /migration-mismatch/ });
  await Effect.runPromise(proof.effect);
  assert.deepEqual(proof.events, []);
});

test("failure to retain the expansion descriptor prevents its deployment", async () => {
  const proof = classProvisioning({
    recordFails: true,
    expectedFailure: /release-operation-failed/,
  });
  await Effect.runPromise(proof.effect);
  assert.deepEqual(proof.events, []);
});

for (const [option, reason] of [
  ["nativeDrift", /native-state-drift/],
  ["futureMissing", /durable-object-class-drift|class-prerequisite/],
] as const)
  test(`later feature reliance refuses ${option} before another version upload`, async () => {
    const proof = classProvisioning({ [option]: true, rerun: true });
    await Effect.runPromise(proof.effect);
    assert.equal(proof.failures.length, 1);
    assert.match(String(proof.failures[0]), reason);
    assert.deepEqual(proof.events, ["expand", "upload", "create-bucket", "activate"]);
  });

test("public recovery refuses a pre-migration Worker version before any restore", async () => {
  const proof = classProvisioning({ recover: "pre-migration" });
  await Effect.runPromise(proof.effect);
  assert.equal(proof.recoveryFailures.length, 1);
  assert.match(String(proof.recoveryFailures[0]), /pre-migration-rollback-refused/);
  assert.ok(!proof.events.includes("recover-version"));
});

test("public recovery can restore a compatible Worker version that retains the class and namespace", async () => {
  const proof = classProvisioning({ recover: "compatible" });
  await Effect.runPromise(proof.effect);
  assert.deepEqual(proof.recoveryFailures, []);
  assert.equal(proof.events.filter((event) => event === "recover-version").length, 1);
});

test("provisioning finishes in expansion, admission, bucket order and a completed rerun retains both without duplicate creation", async () => {
  const proof = classProvisioning({ rerun: true });
  await Effect.runPromise(proof.effect);
  assert.deepEqual(proof.events, [
    "expand",
    "upload",
    "create-bucket",
    "activate",
    "upload",
    "activate",
  ]);
});

test("activation refuses namespace disappearance after the database phase", async () => {
  const proof = classProvisioning({ lateDrift: true });
  await assert.rejects(Effect.runPromise(proof.effect), /declared-class-prerequisite/);
  assert.ok(!proof.events.includes("activate"));
});

test("a lost inactive clone reply reconciles the same exact version without another upload", async () => {
  const proof = classProvisioning({
    loseCloneReply: true,
    rerun: true,
    expectedFailure: /release-operation-failed/,
  });
  await Effect.runPromise(proof.effect);
  assert.equal(proof.failures.length, 1);
  assert.deepEqual(proof.cloneState(), {
    staged: 1,
    removed: 1,
    retained: 0,
    urls: [],
    cloneEvents: ["stage", "remove"],
    active: "expanded",
  });
  assert.ok(
    proof.progress.some(
      (item) => item.clone.versionId === "baseline-clone" && item.clone.status === "ready",
    ),
  );
});

test("refusal after staging leaves only one unrouted clone and keeps the active baseline unchanged across reruns", async () => {
  const proof = classProvisioning({
    refuseAfterClone: true,
    rerun: true,
    expectedFailure: /release-operation-failed/,
  });
  await Effect.runPromise(proof.effect);
  assert.equal(proof.failures.length, 2);
  assert.deepEqual(proof.events, []);
  assert.deepEqual(proof.cloneState(), {
    staged: 1,
    removed: 0,
    retained: 1,
    urls: [],
    cloneEvents: ["stage"],
    active: "previous",
  });
});

test("preview routing enabled refuses before staging any clone", async () => {
  const proof = classProvisioning({
    previewsEnabled: true,
    expectedFailure: /preview-routing-enabled/,
  });
  await Effect.runPromise(proof.effect);
  assert.equal(proof.cloneState().staged, 0);
  assert.deepEqual(proof.events, []);
});

test("combined provisioning preserves its frozen bucket identity through expansion and replan with real release evidence", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "class-release-evidence-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const evidence = releaseEvidence(join(root, "barrier"), "a".repeat(40), "b".repeat(64));
  const proof = classProvisioning({ evidence });
  await Effect.runPromise(proof.effect);
  assert.deepEqual(proof.events, ["expand", "upload", "create-bucket", "activate"]);
  const receipt = JSON.parse(
    await readFile(join(root, "barrier", "declared-changes.json"), "utf8"),
  );
  assert.equal(receipt.resources[0].outcome, "confirmed");
});

test("a pending clone deletion never retries an uncertain DELETE when the clone remains visible", async () => {
  const proof = classProvisioning({
    loseDeleteReply: true,
    rerun: true,
    expectedFailure: /release-operation-failed/,
  });
  await Effect.runPromise(proof.effect);
  assert.equal(proof.cloneState().removed, 1);
  assert.equal(proof.failures.length, 2);
  assert.match(String(proof.failures[1]), /clone-removal-outcome-unknown/);
  assert.ok(!proof.events.includes("upload"));
});

test("a lost successful clone deletion reconciles absence without another DELETE", async () => {
  const proof = classProvisioning({
    loseDeleteReply: true,
    deleteApplied: true,
    rerun: true,
    expectedFailure: /release-operation-failed/,
  });
  await Effect.runPromise(proof.effect);
  assert.equal(proof.cloneState().removed, 1);
  assert.equal(proof.failures.length, 1);
  assert.ok(proof.events.includes("activate"));
});

test("a same-name foreign immutable Worker refuses before any clone or expansion", async () => {
  const proof = classProvisioning({
    foreignLiveWorker: true,
    expectedFailure: /native-target-drift/,
  });
  await Effect.runPromise(proof.effect);
  assert.equal(proof.cloneState().staged, 0);
  assert.deepEqual(proof.events, []);
});
