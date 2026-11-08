import assert from "node:assert/strict";
import { test } from "node:test";
import { Effect } from "effect";
import { provisioningD1, databaseIntent } from "./test/d1-fixture.ts";
import { decodeDeclaredChanges } from "./declared-change-schema.ts";
import { declaredEvidence, declaredRecoveryDigest } from "./declared-evidence.ts";
import { openRecovery } from "./recovery-envelope.ts";

test("declared EU D1 creation follows candidate admission and retains native ownership", async () => {
  const proof = provisioningD1();
  const row = await Effect.runPromise(proof.effect);
  assert.equal(row?.status, "created");
  assert.equal(row?.removalPolicy, "retain");
  assert.equal(row?.resourceType, "Cloudflare.D1Database");
  assert.deepEqual(proof.events, ["preflight-d1", "upload", "admitted", "create-d1", "activate"]);
  assert.equal(proof.readiness.at(-1)?.resources[0]?.ready, true);
});

test("an undeclared D1 is named and refused before any upload or create", async () => {
  const proof = provisioningD1({ undeclared: true });
  await assert.rejects(Effect.runPromise(proof.effect), (error) => {
    assert.ok(error instanceof Error);
    assert.match(error.message, /new-or-unsettled-resource/);
    assert.match(JSON.stringify(error), /PublicSiteWaitlist/);
    return true;
  });
  assert.deepEqual(proof.events, []);
});

test("D1 credential preflight names every database and stops before upload or creation", async () => {
  const proof = provisioningD1({ missingPermission: true, multiple: true });
  await assert.rejects(Effect.runPromise(proof.effect), (error) => {
    const text = JSON.stringify(error);
    assert.match(text, /deploy-token-lacks-d1/);
    assert.match(text, /PublicSiteWaitlist/);
    assert.match(text, /ArchiveWaitlist/);
    assert.doesNotMatch(text, /private-token-error/);
    return true;
  });
  assert.ok(!proof.events.includes("upload"));
  assert.ok(!proof.events.includes("create-d1"));
});

test("a rejected candidate never creates D1", async () => {
  const proof = provisioningD1({ rejectedUpload: true });
  await assert.rejects(Effect.runPromise(proof.effect), /upload-rejected/);
  assert.ok(!proof.events.includes("create-d1"));
});

test("a lost D1 create response remains unknown without activation", async () => {
  const proof = provisioningD1({ createLostReply: true });
  await assert.rejects(Effect.runPromise(proof.effect), /declared-d1-creation-unconfirmed/);
  assert.equal(proof.events.filter((item) => item === "create-d1").length, 1);
  assert.equal(proof.progress.at(-1)?.outcome, "unknown");
  assert.ok(!proof.events.includes("activate"));
});

test("an unknown D1 outcome cannot be retried or adopted", async () => {
  const proof = provisioningD1({ createLostReply: true, retryUnknown: true });
  await assert.rejects(Effect.runPromise(proof.effect), /declared-d1-outcome-unknown/);
  assert.equal(proof.events.filter((item) => item === "create-d1").length, 1);
  assert.ok(!proof.events.includes("activate"));
});

test("acknowledged D1 creation resumes by its recorded UUID without another create", async () => {
  const proof = provisioningD1({ readFailsOnce: true, resume: true });
  const row = await Effect.runPromise(proof.effect);
  assert.equal(row?.status, "created");
  assert.equal(proof.events.filter((item) => item === "create-d1").length, 1);
  assert.equal(proof.events.filter((item) => item === "activate").length, 1);
});

for (const lateDrift of ["missing", "identity", "jurisdiction"] as const)
  test(`D1 ${lateDrift} drift refuses Worker activation and replaces readiness`, async () => {
    const proof = provisioningD1({ lateDrift });
    await assert.rejects(
      Effect.runPromise(proof.effect),
      /declared-(?:prerequisite|d1-observation)/,
    );
    assert.ok(!proof.events.includes("activate"));
    assert.equal(proof.readiness.at(-1)?.resources[0]?.ready, false);
  });

test("a D1 name collision cannot be adopted", async () => {
  const proof = provisioningD1({ collision: true });
  await assert.rejects(Effect.runPromise(proof.effect), /declared-d1-name-collision/);
  assert.ok(!proof.events.includes("create-d1"));
});

test("D1 binding use must wait for a separate provisioning release", async () => {
  const proof = provisioningD1({ featureBinding: true });
  await assert.rejects(Effect.runPromise(proof.effect), /declared-prerequisite-missing/);
  assert.ok(!proof.events.includes("upload"));
  assert.ok(!proof.events.includes("create-d1"));
});

test("a later D1 binding release observes retained ownership without recreating", async () => {
  const proof = provisioningD1({ laterBinding: true });
  const row = await Effect.runPromise(proof.effect);
  assert.equal(row?.status, "created");
  assert.equal(proof.events.filter((item) => item === "create-d1").length, 1);
  assert.equal(proof.events.filter((item) => item === "activate").length, 2);
  assert.ok(proof.bindings.length > 0);
  assert.deepEqual(proof.bindings.at(-1), [
    { type: "d1", name: "WAITLIST", databaseId: "11111111-1111-4111-8111-111111111111" },
  ]);
});

test("a lost native D1 row cannot recreate a journaled database", async () => {
  const proof = provisioningD1({ lostRow: true });
  await assert.rejects(Effect.runPromise(proof.effect), /declared-resource-history-without-state/);
  assert.equal(proof.events.filter((item) => item === "create-d1").length, 1);
});

test("removing the D1 declaration refuses without losing retained ownership", async () => {
  const proof = provisioningD1({ removeDeclaration: true });
  await assert.rejects(Effect.runPromise(proof.effect), /declared-resource-declaration-removed/);
  assert.equal(proof.events.filter((item) => item === "activate").length, 1);
});

test("failed D1 intent evidence stops before create", async () => {
  const proof = provisioningD1({ recordFails: true });
  await assert.rejects(Effect.runPromise(proof.effect), /declared-d1-creation-unconfirmed/);
  assert.ok(!proof.events.includes("create-d1"));
});

test("D1 receipts distinguish creation, observed readiness, activation and retention", async () => {
  const proof = provisioningD1();
  await Effect.runPromise(proof.effect);
  const writes = new Map<string, unknown>();
  const evidence = declaredEvidence(
    async (name, value) => {
      writes.set(name, value);
    },
    "a".repeat(40),
    "b".repeat(64),
  );
  for (const progress of proof.progress) await evidence.declared(progress);
  await evidence.declaredReadiness(proof.readiness.at(-1)!);
  const summary = evidence.summary("failed", []);
  assert.match(summary, /Cloudflare.D1Database \/ create-d1-database/);
  assert.match(summary, /confirmed/);
  assert.match(summary, /observed-ready/);
  assert.match(summary, /Activated Worker versions: 0/);
  assert.match(summary, /Retain data, native row and recovery descriptor/);
  assert.doesNotMatch(
    JSON.stringify(writes.get("declared-changes.json")),
    /11111111-1111|public-site-waitlist/,
  );
  const sealed = writes.get("declared-recovery.sealed.json");
  const progress = proof.progress.at(-1)!;
  assert.ok("database" in progress);
  const manifest = declaredRecoveryDigest("a".repeat(40), progress.database.declaration);
  const recovered = openRecovery(sealed, "b".repeat(64), "a".repeat(40), manifest);
  assert.match(JSON.stringify(recovered), /11111111-1111-4111-8111-111111111111/);
  assert.match(JSON.stringify(recovered), /public-site-waitlist/);
  assert.throws(
    () => openRecovery(sealed, "b".repeat(64), "a".repeat(40), "f".repeat(64)),
    /authentication-failed/,
  );
});

test("D1 declarations reject supplied UUIDs, non-EU jurisdiction and undeclared SQL operations", () => {
  for (const props of [
    { ...databaseIntent.changes[0]!.props, databaseId: "foreign" },
    { ...databaseIntent.changes[0]!.props, jurisdiction: "us" },
    { ...databaseIntent.changes[0]!.props, migrations: "sql" },
  ])
    assert.throws(() =>
      decodeDeclaredChanges({
        ...databaseIntent,
        changes: [{ ...databaseIntent.changes[0], props }],
      }),
    );
});

for (const options of [{ nativeD1: true }, { nativeD1: true, readFailsOnce: true, resume: true }])
  test(`native D1 provider commits and resumes only the acknowledged identity ${JSON.stringify(options)}`, async () => {
    const proof = provisioningD1(options);
    const row = await Effect.runPromise(proof.effect);
    assert.ok(row?.status === "created" || row?.status === "updated");
    assert.equal(row.attr.databaseId, "11111111-1111-4111-8111-111111111111");
    assert.equal(proof.events.filter((item) => item === "create-d1").length, 1);
  });
test("native D1 recovery cannot adopt an unknown creation", async () => {
  const proof = provisioningD1({ nativeD1: true, createLostReply: true, retryUnknown: true });
  await assert.rejects(Effect.runPromise(proof.effect), /declared-d1-outcome-unknown/);
  assert.equal(proof.events.filter((item) => item === "create-d1").length, 1);
});
test("native D1 recovery cannot replace the acknowledged UUID with a same-name database", async () => {
  const proof = provisioningD1({
    nativeD1: true,
    readFailsOnce: true,
    resume: true,
    recoveredForeign: true,
  });
  await assert.rejects(Effect.runPromise(proof.effect), /declared-prerequisite-identity-mismatch/);
  assert.equal(proof.events.filter((item) => item === "create-d1").length, 1);
});

test("D1 collisions name every blocked declaration before any create", async () => {
  const proof = provisioningD1({ multiple: true, collision: true });
  await assert.rejects(Effect.runPromise(proof.effect), (error) => {
    assert.ok(error instanceof Error && "refusals" in error && Array.isArray(error.refusals));
    assert.deepEqual(error.refusals.map((item) => item.fqn).sort(), [
      "ArchiveWaitlist",
      "PublicSiteWaitlist",
    ]);
    assert.ok(error.refusals.every((item) => item.reason === "declared-d1-name-collision"));
    return true;
  });
  assert.ok(!proof.events.includes("create-d1"));
});
