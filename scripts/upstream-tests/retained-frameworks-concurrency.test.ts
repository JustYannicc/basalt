import assert from "node:assert/strict";
import { test } from "node:test";
import { Clock, Effect, Exit, Fiber } from "effect";
import { TestClock } from "effect/testing";
import { retainedFrameworks } from "../../.upstream/apps/hosted/cloud/src/infrastructure/production-ops/retained-frameworks.ts";
import { retainedFrameworkObjects } from "../../.upstream/apps/hosted/cloud/src/infrastructure/production-ops/retained-frameworks-r2.ts";
import { refusalDiagnostic } from "../../.upstream/apps/hosted/cloud/src/infrastructure/production-ops/diagnostics.ts";
import {
  bucketFixture,
  encoded,
  metadata,
  nativeBody,
  nativeObject,
  record,
} from "./retained-frameworks-fixture.ts";

const identity = { version: "1.2.3", sha256: "a".repeat(64) };
const references = Array.from({ length: 327 }, (_, index) => ({
  app: "app_one",
  deployment: `dpl_${index}`,
  build: `bld_${index}`,
}));

const run = (fixture: ReturnType<typeof bucketFixture>, refs = references) =>
  Effect.gen(function* () {
    const startedAt = yield* Clock.currentTimeMillis;
    let elapsedMs = 0;
    const fiber = yield* retainedFrameworks(refs, retainedFrameworkObjects(fixture.bucket)).pipe(
      Effect.provide(fixture.logger),
      Effect.onExit(() =>
        Effect.gen(function* () {
          elapsedMs = (yield* Clock.currentTimeMillis) - startedAt;
        }),
      ),
      Effect.forkChild,
    );
    yield* TestClock.adjust("18 seconds");
    const exit = yield* Fiber.await(fiber);
    yield* TestClock.adjust("7 seconds");
    return { exit, elapsedMs };
  }).pipe(Effect.provide(TestClock.layer()), Effect.scoped, Effect.runPromise);

test("327 retained records at 100 ms each finish with six seconds of phase headroom", async (t) => {
  const fixture = bucketFixture();
  fixture.objects.push(metadata(identity.version, identity.sha256));
  const body = encoded(record(identity));
  const reads: string[] = [];
  let active = 0;
  let maximumActive = 0;
  fixture.bucket.get = (key) =>
    Effect.acquireUseRelease(
      Effect.sync(() => {
        reads.push(key);
        active++;
        maximumActive = Math.max(maximumActive, active);
      }),
      () =>
        Effect.sleep("100 millis").pipe(
          Effect.map(() => nativeObject(body.byteLength, nativeBody(body))),
        ),
      () =>
        Effect.sync(() => {
          active--;
        }),
    );
  const { exit, elapsedMs } = await run(fixture);
  t.diagnostic(JSON.stringify({ records: reads.length, elapsedMs, maximumActive }));
  assert.ok(Exit.isSuccess(exit), "All 327 records must finish before the 18-second phase bound");
  assert.equal(exit.value.complete, true);
  assert.equal(exit.value.builds.length, 327);
  assert.deepEqual(
    exit.value.builds.map((build) => build.build),
    references.map((ref) => ref.build),
  );
  assert.equal(reads.length, 327);
  assert.equal(new Set(reads).size, 327);
  assert.equal(maximumActive, 4);
  assert.equal(active, 0);
  assert.ok(elapsedMs <= 12_000, `Expected at least six seconds of headroom, got ${elapsedMs} ms`);
  assert.equal(fixture.writes(), 0);
});

test("one hung legacy record refuses within the bound with its own read position", async (t) => {
  const fixture = bucketFixture();
  fixture.objects.push(metadata(identity.version, identity.sha256));
  const body = encoded(record(identity));
  let active = 0;
  let hungAttempts = 0;
  fixture.bucket.get = (key) =>
    Effect.acquireUseRelease(
      Effect.sync(() => {
        active++;
      }),
      () => {
        if (key === "bld_0/worker.json") return Effect.succeed(null);
        if (key === "bld_0.json") {
          hungAttempts++;
          return Effect.never;
        }
        return Effect.sleep("100 millis").pipe(
          Effect.map(() => nativeObject(body.byteLength, nativeBody(body))),
        );
      },
      () =>
        Effect.sync(() => {
          active--;
        }),
    );
  const { exit, elapsedMs } = await run(fixture);
  assert.ok(Exit.isFailure(exit));
  const diagnostic = refusalDiagnostic(exit.cause, "sql");
  t.diagnostic(JSON.stringify({ elapsedMs, diagnostic }));
  assert.equal(diagnostic.reasonCode, "read_timeout");
  assert.equal(diagnostic.objectClass, "legacy_record");
  assert.equal(diagnostic.readPhase, "read");
  assert.equal(diagnostic.work?.references, 327);
  assert.equal(diagnostic.work?.builds, 327);
  assert.equal(hungAttempts, 3);
  assert.ok(elapsedMs <= 10_000);
  assert.ok(diagnostic.work!.completedBuilds < 327);
  assert.equal(active, 0);
  assert.equal(fixture.writes(), 0);
});

test("in-flight byte reservations wait for refunds before reading a full-size record", async () => {
  const fixture = bucketFixture();
  fixture.objects.push(metadata(identity.version, identity.sha256));
  const body = encoded(record(identity));
  const large = new TextEncoder().encode(JSON.stringify(record(identity)).padEnd(8_000_000, " "));
  let reads = 0;
  fixture.bucket.get = (key) =>
    Effect.sync(() => {
      reads++;
    }).pipe(
      Effect.andThen(Effect.sleep("2 seconds")),
      Effect.map(() => {
        const selected = key === "bld_4/worker.json" ? large : body;
        return nativeObject(selected.byteLength, nativeBody(selected));
      }),
    );
  const { exit } = await run(fixture, references.slice(0, 5));
  assert.ok(Exit.isSuccess(exit));
  assert.equal(exit.value.complete, true);
  assert.equal(exit.value.builds.length, 5);
  assert.equal(reads, 5, "Waiting for byte headroom cannot time out a healthy provider attempt");
});
