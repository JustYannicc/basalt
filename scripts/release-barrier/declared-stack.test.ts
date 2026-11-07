import assert from "node:assert/strict";
import { test } from "node:test";
import { Effect } from "effect";
import { provisioning } from "./test/declared-fixture.ts";

test("provisioning creates a declared bucket only after whole-candidate admission and retains native state", async () => {
  const proof = provisioning();
  const row = await Effect.runPromise(proof.effect);
  assert.equal(row?.status, "created");
  assert.equal(row?.removalPolicy, "retain");
  assert.deepEqual(proof.events, ["upload", "admitted", "create-bucket", "activate"]);
});

test("completed provisioning cannot recreate a bucket after its native row is lost", async () => {
  const proof = provisioning({ lostRow: true });
  await assert.rejects(Effect.runPromise(proof.effect), /declared-resource-history-without-state/);
  assert.equal(proof.events.filter((event) => event === "create-bucket").length, 1);
});

test("a later candidate refuses a missing live bucket even when its native row survives", async () => {
  const proof = provisioning({ missingPrerequisite: true });
  await assert.rejects(Effect.runPromise(proof.effect), /declared-prerequisite-missing/);
  assert.equal(proof.events.filter((event) => event === "upload").length, 1);
  assert.equal(proof.readiness.at(-1)?.resources[0]?.ready, false);
});

for (const lateDrift of ["missing", "identity"] as const)
  test(`activation re-observes declared bucket ${lateDrift} after database work`, async () => {
    const proof = provisioning({ lateDrift });
    await assert.rejects(Effect.runPromise(proof.effect), /declared-prerequisite/);
    assert.ok(!proof.events.includes("activate"));
    assert.equal(proof.readiness.at(-1)?.resources[0]?.ready, false);
  });

test("a rejected candidate never creates declared storage", async () => {
  const proof = provisioning({ rejectedUpload: true });
  await assert.rejects(Effect.runPromise(proof.effect), /upload-rejected/);
  assert.ok(!proof.events.includes("create-bucket"));
});

test("a lost create reply remains unknown and never activates the candidate", async () => {
  const proof = provisioning({ createLostReply: true });
  await assert.rejects(Effect.runPromise(proof.effect), /declared-bucket-creation-unconfirmed/);
  assert.equal(proof.events.filter((event) => event === "create-bucket").length, 1);
  assert.equal(proof.progress.at(-1)?.outcome, "unknown");
  assert.ok(!proof.events.includes("activate"));
});

test("an acknowledged creation resumes by observation without another create", async () => {
  const proof = provisioning({ readFailsOnce: true, resume: true });
  const row = await Effect.runPromise(proof.effect);
  assert.equal(row?.status, "created");
  assert.equal(proof.events.filter((event) => event === "create-bucket").length, 1);
  assert.equal(proof.events.filter((event) => event === "activate").length, 1);
});

test("an uncertain create cannot be retried or adopted by the next release", async () => {
  const proof = provisioning({ createLostReply: true, retryUnknown: true });
  await assert.rejects(Effect.runPromise(proof.effect), /declared-bucket-outcome-unknown/);
  assert.equal(proof.events.filter((event) => event === "create-bucket").length, 1);
  assert.ok(!proof.events.includes("activate"));
});

test("a same-name collision is never adopted", async () => {
  const proof = provisioning({ collision: true });
  await assert.rejects(Effect.runPromise(proof.effect), /declared-bucket-name-collision/);
  assert.ok(!proof.events.includes("create-bucket"));
  assert.ok(!proof.events.includes("activate"));
});

test("feature use of an absent bucket refuses before Worker preparation", async () => {
  const proof = provisioning({ featureBinding: true });
  await assert.rejects(Effect.runPromise(proof.effect), /declared-prerequisite-missing/);
  assert.deepEqual(proof.events, []);
});

test("a provider observation failure keeps safe diagnostics through the public deployment path", async () => {
  const proof = provisioning({ providerError: true });
  await assert.rejects(Effect.runPromise(proof.effect), (error: unknown) => {
    assert.ok(error instanceof Error && "delta" in error);
    const text = JSON.stringify(error);
    assert.ok(text.includes("403"));
    assert.ok(text.includes("10000"));
    assert.ok(!text.includes("private-provider-detail"));
    return true;
  });
  assert.ok(!proof.events.includes("activate"));
});

test("the actual native R2 resource and provider plan commit the generated owned identity", async () => {
  const proof = provisioning({ nativeBucket: true });
  const row = await Effect.runPromise(proof.effect);
  assert.ok(row?.status === "created" || row?.status === "updated");
  assert.equal(row.resourceType, "Cloudflare.R2.Bucket");
  assert.equal(row.removalPolicy, "retain");
  assert.equal(row.attr.accountId, "fixture");
  assert.match(row.attr.bucketName, /^fixture-driverecords-production-[a-z0-9]+$/);
  assert.deepEqual(proof.events, ["upload", "admitted", "create-bucket", "activate"]);
});
