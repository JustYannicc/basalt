import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { BarrierRefusal } from "./manifest.ts";
import { reportRefusal } from "./refusal-report.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { Effect } from "effect";
import { classProvisioning } from "./test/declared-class-fixture.ts";
import { declaredChecks } from "./declared-checks.ts";
import { provisioningD1 } from "./test/d1-fixture.ts";

// The reviewed class expansion replans while new storage still has no native row.
test("SQLite expansion preserves frozen bucket and D1 ownership through one preparation path", async () => {
  const proof = classProvisioning({ d1: {}, companion: "numeric" });
  await Effect.runPromise(proof.effect);
  assert.equal(proof.failures.length, 0);
  for (const fqn of ["DriveRecords", "PublicSiteWaitlist"]) {
    const resources = proof.storageProgress
      .map((value) => ("bucket" in value ? value.bucket : value.database))
      .filter((resource) => resource.fqn === fqn);
    assert.ok(resources.length >= 2);
    assert.equal(new Set(resources.map((resource) => resource.native.instanceId)).size, 1);
  }
  assert.equal(proof.events.filter((event) => event === "expand").length, 1);
  assert.equal(proof.events.filter((event) => event === "create-d1").length, 1);
  assert.ok(proof.events.indexOf("expand") < proof.events.indexOf("upload"));
  assert.equal(proof.events.filter((event) => event === "upload").length, 2);
  assert.ok(proof.events.lastIndexOf("upload") < proof.events.indexOf("admitted"));
  assert.ok(proof.events.indexOf("admitted") < proof.events.indexOf("create-d1"));
  assert.ok(proof.events.indexOf("create-d1") < proof.events.indexOf("activate"));
});

test("missing D1 read permission refuses before class expansion or any storage creation", async () => {
  const proof = classProvisioning({
    d1: { missingPermission: true },
    expectedFailure: /deploy-token-lacks-d1/,
  });
  await Effect.runPromise(proof.effect);
  assert.equal(proof.failures.length, 1);
  assert.ok(!proof.events.includes("expand"));
  assert.ok(!proof.events.includes("create-bucket"));
  assert.ok(!proof.events.includes("create-d1"));
});

test("class expansion followed by refused admission creates no declared D1", async () => {
  const proof = classProvisioning({ d1: {}, reject: true });
  await Effect.runPromise(proof.effect);
  assert.equal(proof.failures.length, 1);
  assert.ok(proof.events.includes("expand"));
  assert.ok(!proof.events.includes("create-d1"));
});

test("a native waiting-list reference binds the retained database without another declaration or create", async () => {
  const proof = provisioningD1({ nativeD1: true, laterBinding: true });
  const row = await Effect.runPromise(proof.effect);
  assert.ok(row?.status === "created" || row?.status === "updated");
  assert.equal(row.removalPolicy, "retain");
  assert.deepEqual(proof.bindings.at(-1), [
    { type: "d1", name: "WAITLIST", databaseId: row.attr.databaseId },
  ]);
  assert.equal(proof.events.filter((event) => event === "create-d1").length, 1);
});

test("mixed declarations retain an unknown D1 outcome without retry or repeated class expansion", async () => {
  const proof = classProvisioning({
    d1: { unknown: true },
    rerun: true,
    expectedFailure: /declared-d1-creation-unconfirmed/,
  });
  await Effect.runPromise(proof.effect);
  assert.equal(proof.failures.length, 2);
  assert.match(String(proof.failures[1]), /declared-d1-outcome-unknown/);
  assert.equal(proof.events.filter((event) => event === "create-d1").length, 1);
  assert.equal(proof.events.filter((event) => event === "expand").length, 1);
  assert.ok(!proof.events.includes("activate"));
});

test("mixed declarations resume an acknowledged D1 by observation", async () => {
  const proof = classProvisioning({
    d1: { readFailsOnce: true },
    rerun: true,
    expectedFailure: /declared-d1-provider-failed/,
  });
  await Effect.runPromise(proof.effect);
  assert.equal(proof.failures.length, 1);
  assert.equal(proof.events.filter((event) => event === "create-d1").length, 1);
  assert.equal(proof.events.filter((event) => event === "expand").length, 1);
  assert.equal(proof.events.filter((event) => event === "activate").length, 1);
});

test("one refusal mapper aggregates correctly typed failures for all declaration kinds", async () => {
  const types = ["Cloudflare.R2.Bucket", "Cloudflare.D1Database", "Cloudflare.Worker"] as const;
  await assert.rejects(
    Effect.runPromise(
      declaredChecks(
        types.map((type, index) => ({
          fqn: `Resource${index}`,
          type,
          check: Effect.fail(new Error("private-provider-details")),
        })),
      ),
    ),
    (error) => {
      assert.ok(error instanceof Error && "refusals" in error && Array.isArray(error.refusals));
      assert.deepEqual(
        error.refusals.map((item) => [item.fqn, item.type, item.reason]),
        [
          ["Resource0", "Cloudflare.R2.Bucket", "declared-bucket-provider-failed"],
          ["Resource1", "Cloudflare.D1Database", "declared-d1-provider-failed"],
          ["Resource2", "Cloudflare.Worker", "declared-class-provider-failed"],
        ],
      );
      assert.doesNotMatch(JSON.stringify(error), /private-provider-details/);
      return true;
    },
  );
});

for (const jurisdiction of ["us", "default"] as const)
  test(`declared D1 ${jurisdiction} intent drift keeps exact safe values in both public outputs`, async (context) => {
    const privateName = "synthetic-private-token";
    const proof = provisioningD1({ plannedJurisdiction: jurisdiction, plannedName: privateName });
    let failure: unknown;
    try {
      await Effect.runPromise(proof.effect);
    } catch (error) {
      failure = error;
    }
    assert.ok(failure instanceof BarrierRefusal);
    assert.equal(failure.reason, "declaration-does-not-match-plan");
    assert.deepEqual(
      failure.delta?.changed.find((change) => change.path === "jurisdiction"),
      { path: "jurisdiction", old: "eu", new: jurisdiction },
    );
    const directory = await mkdtemp(join(tmpdir(), "d1-intent-refusal-"));
    context.after(() => rm(directory, { recursive: true, force: true }));
    const summary = join(directory, "summary.md");
    const errors: string[] = [];
    await reportRefusal(failure, summary, (message) => errors.push(message));
    for (const output of [errors.join("\n"), await readFile(summary, "utf8")]) {
      assert.ok(
        output.includes(`| PublicSiteWaitlist | jurisdiction | "eu" → "${jurisdiction}" |`),
      );
      assert.ok(!output.includes(privateName));
    }
    assert.deepEqual(proof.events, []);
  });
