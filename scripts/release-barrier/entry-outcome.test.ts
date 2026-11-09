import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Effect, Exit } from "effect";
import { releaseEvidence } from "./evidence.ts";
import { releaseOutcome } from "./entry-outcome.ts";
import { classProvisioning } from "./test/declared-class-fixture.ts";

for (const scenario of ["success", "admission-refusal", "later-refusal", "thrown-failure"] as const)
  test(`release entry publishes retained outcomes on ${scenario}`, async (context) => {
    context.mock.method(console, "error", () => {});
    const root = await mkdtemp(join(tmpdir(), "release-outcome-"));
    context.after(() => rm(root, { recursive: true, force: true }));
    const summaryPath = join(root, "summary.md");
    const evidence = releaseEvidence(root, "a".repeat(40), "b".repeat(64));
    const proof = classProvisioning({
      evidence,
      d1: {},
      ...(scenario === "admission-refusal" ? { reject: true } : {}),
      ...(scenario === "later-refusal" ? { lateDrift: true, expectedFailure: /declared-/ } : {}),
    });
    const run = () =>
      releaseOutcome(evidence, summaryPath, async () => {
        await Effect.runPromise(proof.effect);
        if (scenario === "thrown-failure") throw new Error("synthetic private failure details");
        return proof.failures.length ? Exit.fail(proof.failures[0]) : Exit.succeed(undefined);
      });
    if (scenario === "thrown-failure")
      await assert.rejects(run(), /synthetic private failure details/);
    else assert.equal(await run(), scenario === "success" ? 0 : 1);

    assert.ok(proof.events.includes("expand"));
    const summary = await readFile(summaryPath, "utf8");
    assert.match(summary, /## Declared class expansion/);
    assert.match(
      summary,
      new RegExp(
        `\\| AppData \\| add-sqlite-class \\| ${scenario === "later-refusal" ? "not-ready" : "ready"} \\| true \\|`,
      ),
    );
    assert.ok(proof.progress.some((value) => value.outcome === "ready"));
    assert.match(summary, /expanded \| baseline-clone \|/);
    assert.match(summary, /Startup evidence below is post-deployment/);
    assert.match(summary, /## Declared storage/);
    assert.match(summary, /DriveRecords.*Cloudflare.R2.Bucket \/ create-bucket/);
    assert.match(summary, /PublicSiteWaitlist.*Cloudflare.D1Database \/ create-d1-database/);
    assert.match(summary, /Readiness/);
    assert.match(
      summary,
      new RegExp(`Release disposition: ${scenario === "success" ? "complete" : "failed"}`),
    );
    assert.equal(summary.match(/## Declared storage/g)?.length, 1);

    if (scenario === "admission-refusal") {
      assert.ok(!proof.events.includes("create-bucket"));
      assert.ok(!proof.events.includes("create-d1"));
      assert.match(summary, /planned \| not-started \| not-ready/);
      assert.match(summary, /Activated Worker versions: 0/);
    } else {
      assert.ok(proof.events.includes("create-bucket"));
      assert.ok(proof.events.includes("create-d1"));
      assert.match(summary, /created \| confirmed \| observed-ready/);
    }
    if (scenario === "admission-refusal" || scenario === "later-refusal") {
      assert.match(summary, /## Release barrier refused/);
      const failure = JSON.parse(await readFile(join(root, "failure.json"), "utf8"));
      assert.equal(failure.activated.length, 0);
      assert.match(summary, /Activated Worker versions: 0/);
    }
    assert.doesNotMatch(
      summary,
      /11111111-1111|public-site-waitlist|fixture-appdata|export default|synthetic private failure details/,
    );
  });
