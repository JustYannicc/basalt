import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { Cause, Effect, Exit, Fiber, Clock } from "effect";
import { TestClock } from "effect/testing";
import {
  bucketFixture,
  encoded,
  metadata,
  moduleText,
  nativeBody,
  nativeObject,
  record,
} from "./retained-frameworks-fixture.ts";
import { retainedFrameworks } from "../../.upstream/apps/hosted/cloud/src/infrastructure/production-ops/retained-frameworks.ts";
import { retainedFrameworkObjects } from "../../.upstream/apps/hosted/cloud/src/infrastructure/production-ops/retained-frameworks-r2.ts";
import { refusalDiagnostic } from "../../.upstream/apps/hosted/cloud/src/infrastructure/production-ops/diagnostics.ts";

const identity = {
  version: "1.2.3",
  sha256: createHash("sha256")
    .update(JSON.stringify([["node_modules/apps/server.js", "synthetic framework"]]))
    .digest("hex"),
};
const references = (count = 1) =>
  Array.from({ length: count }, (_, index) => ({
    app: "app_one",
    deployment: `dpl_${index}`,
    build: `bld_${index}`,
  }));
const transient = () => Object.assign(new Error(moduleText), { name: "ServiceUnavailable" });
const run = (fixture: ReturnType<typeof bucketFixture>, count = 1) =>
  Effect.gen(function* () {
    const started = yield* Clock.currentTimeMillis;
    let finished = started;
    const fiber = yield* retainedFrameworks(
      references(count),
      retainedFrameworkObjects(fixture.bucket),
    ).pipe(
      Effect.provide(fixture.logger),
      Effect.onExit(() =>
        Effect.gen(function* () {
          finished = yield* Clock.currentTimeMillis;
        }),
      ),
      Effect.forkChild,
    );
    yield* TestClock.adjust("18 seconds");
    return { exit: yield* Fiber.await(fiber), started, elapsedMs: finished - started };
  }).pipe(Effect.provide(TestClock.layer()), Effect.scoped, Effect.runPromise);

for (const phase of ["metadata", "get", "body"] as const)
  test(`transient R2 ${phase} reads recover within the inventory deadline`, async () => {
    const fixture = bucketFixture();
    fixture.objects.push(metadata(identity.version, identity.sha256));
    const body = encoded(record(identity));
    let attempts = 0;
    const list = fixture.bucket.list;
    if (phase === "metadata")
      fixture.bucket.list = (options) =>
        Effect.suspend(() =>
          ++attempts === 1 ? Effect.fail({ _tag: "R2Error", cause: transient() }) : list(options),
        );
    fixture.bucket.get = () =>
      Effect.suspend(() => {
        if (phase === "metadata")
          return Effect.succeed(nativeObject(body.byteLength, nativeBody(body)));
        attempts++;
        if (phase === "get" && attempts === 1)
          return Effect.fail({ _tag: "R2Error", cause: transient() });
        return Effect.succeed(
          nativeObject(
            body.byteLength,
            phase === "body" && attempts === 1
              ? new ReadableStream<Uint8Array>({
                  start(controller) {
                    controller.error(transient());
                  },
                })
              : nativeBody(body),
          ),
        );
      });
    const { exit } = await run(fixture);
    assert.ok(Exit.isSuccess(exit));
    assert.equal(exit.value.complete, true);
    assert.equal(attempts, 2);
    assert.equal(fixture.writes(), 0);
    assert.ok(!JSON.stringify({ value: exit.value, logs: fixture.logs }).includes(moduleText));
  });

test("a stalled body attempt releases its native reader before a successful retry", async () => {
  const fixture = bucketFixture();
  fixture.objects.push(metadata(identity.version, identity.sha256));
  const body = encoded(record(identity));
  const stalled = new ReadableStream<Uint8Array>({
    cancel() {
      return new Promise<void>(() => {});
    },
  });
  let attempts = 0;
  fixture.bucket.get = () =>
    Effect.sync(() => nativeObject(body.byteLength, ++attempts === 1 ? stalled : nativeBody(body)));
  const { exit } = await run(fixture);
  assert.ok(Exit.isSuccess(exit));
  assert.equal(exit.value.complete, true);
  assert.equal(attempts, 2);
  assert.equal(stalled.locked, false);
});

test("failed transient partial streams keep every attempt's byte reservation", async () => {
  const fixture = bucketFixture();
  let gets = 0;
  let delivered = 0;
  fixture.bucket.get = () =>
    Effect.sync(() => {
      gets++;
      let sent = false;
      return nativeObject(
        8_000_000,
        new ReadableStream<Uint8Array>(
          {
            pull(controller) {
              if (sent) controller.error(transient());
              else {
                sent = true;
                delivered += 7_000_000;
                controller.enqueue(new Uint8Array(7_000_000));
              }
            },
          },
          { highWaterMark: 0 },
        ),
      );
    });
  const { exit } = await run(fixture, 5);
  assert.ok(Exit.isFailure(exit));
  assert.match(Cause.pretty(exit.cause), /total byte bound/);
  assert.equal(gets, 4);
  assert.equal(delivered, 28_000_000);
});

test("a stalled metadata read gets at most three bounded attempts", async () => {
  const fixture = bucketFixture();
  let attempts = 0;
  fixture.bucket.list = () =>
    Effect.suspend(() => {
      attempts++;
      return Effect.never;
    });
  const { exit } = await run(fixture);
  assert.ok(Exit.isFailure(exit));
  assert.equal(attempts, 3);
  const guard = refusalDiagnostic(exit.cause, "sql");
  assert.equal(guard.reasonCode, "read_timeout");
  assert.equal(guard.objectClass, "framework_metadata");
  assert.equal(guard.readPhase, "list");
  assert.ok(guard.elapsedMs! >= 9300 && guard.elapsedMs! <= 9360);
  assert.equal(guard.work?.metadataAttempts, 3);
  assert.ok(!JSON.stringify(guard).includes(moduleText));
});

test("healthy cumulative reads complete past eight seconds while pages, records and retries share one phase cap", async () => {
  for (const [pages, count] of [
    [false, 6],
    [true, 10],
    [false, 10],
  ] as const) {
    const fixture = bucketFixture();
    fixture.objects.push(metadata(identity.version, identity.sha256));
    let calls = 0;
    let metadataAttempts = 0;
    if (pages)
      fixture.bucket.list = () =>
        Effect.suspend(() => {
          metadataAttempts++;
          return metadataAttempts % 2 === 1
            ? Effect.never
            : Effect.sleep("2900 millis").pipe(
                Effect.map(() => {
                  calls++;
                  return { objects: [], truncated: true, cursor: `page_${calls}` };
                }),
              );
        });
    else {
      const body = encoded(record(identity));
      fixture.bucket.get = () =>
        Effect.suspend(() => {
          calls++;
          return Effect.sleep("2 seconds").pipe(
            Effect.map(() => nativeObject(body.byteLength, nativeBody(body))),
          );
        });
    }
    const { exit, elapsedMs } = await run(fixture, count);
    if (!pages && count === 6) {
      assert.ok(
        Exit.isSuccess(exit),
        "Six healthy reads must complete after their cumulative twelve seconds",
      );
      assert.equal(exit.value.complete, true);
      assert.equal(calls, 6);
      assert.equal(elapsedMs, 12_000);
      continue;
    }
    assert.ok(Exit.isFailure(exit));
    const diagnostic = refusalDiagnostic(exit.cause, "sql");
    assert.equal(diagnostic.reasonCode, "time_bound");
    assert.equal(diagnostic.elapsedMs, 18_000);
    assert.equal(diagnostic.objectClass, pages ? "framework_metadata" : "split_record");
    assert.equal(diagnostic.readPhase, pages ? "list" : "read");
    assert.equal(calls, pages ? 2 : 9);
    assert.equal(diagnostic.work?.builds, 10);
    assert.equal(diagnostic.work?.metadataPages, pages ? 2 : 1);
    assert.equal(diagnostic.work?.recordAttempts, pages ? 0 : 9);
  }
});

test("permanent access failures do not retry or expose native provider text", async () => {
  const fixture = bucketFixture();
  let attempts = 0;
  fixture.bucket.list = () =>
    Effect.suspend(() => {
      attempts++;
      return Effect.fail({
        _tag: "R2Error",
        cause: Object.assign(new Error(moduleText), { name: "Forbidden" }),
      });
    });
  const { exit } = await run(fixture);
  assert.ok(Exit.isFailure(exit));
  assert.equal(attempts, 1);
  assert.equal(refusalDiagnostic(exit.cause, "sql").reasonCode, "unreadable_metadata");
  assert.ok(!JSON.stringify({ exit, logs: fixture.logs }).includes(moduleText));
});

test("a metadata retry keeps its cursor and does not replay completed pages", async () => {
  const fixture = bucketFixture();
  const cursors: (string | undefined)[] = [];
  fixture.bucket.list = (options) =>
    Effect.suspend((): ReturnType<typeof fixture.bucket.list> => {
      cursors.push(options.cursor);
      if (options.cursor === undefined)
        return Effect.succeed({ objects: [], truncated: true, cursor: "next" });
      if (cursors.length === 2) return Effect.fail({ _tag: "R2Error", cause: transient() });
      return Effect.succeed({
        objects: [metadata(identity.version, identity.sha256)],
        truncated: false,
      });
    });
  fixture.bodies.set("bld_0/worker.json", encoded(record(identity)));
  const { exit } = await run(fixture);
  assert.ok(Exit.isSuccess(exit));
  assert.equal(exit.value.complete, true);
  assert.deepEqual(cursors, [undefined, "next", "next"]);
});

test("the R2 phase shrinks after SQL work and leaves the response reserve inside the shared outer bound", async () => {
  const { retainedFrameworkReadBudget } =
    await import("../../.upstream/apps/hosted/cloud/src/infrastructure/production-ops/retained-frameworks-read.ts");
  for (const [elapsed, expected] of [
    [0, 18000],
    [5000, 18000],
    [12000, 11000],
    [23000, 0],
    [25000, 0],
  ])
    await Effect.runPromise(
      Effect.gen(function* () {
        const started = yield* Clock.currentTimeMillis;
        yield* TestClock.adjust(elapsed);
        assert.equal(yield* retainedFrameworkReadBudget(started), expected);
      }).pipe(Effect.provide(TestClock.layer())),
    );
  const fixture = bucketFixture();
  let gets = 0;
  fixture.bucket.get = () =>
    Effect.suspend(() => {
      gets++;
      return Effect.never;
    });
  const exit = await Effect.runPromise(
    Effect.gen(function* () {
      const started = yield* Clock.currentTimeMillis;
      yield* TestClock.adjust("22 seconds");
      const budget = yield* retainedFrameworkReadBudget(started);
      const fiber = yield* retainedFrameworks(
        references(),
        retainedFrameworkObjects(fixture.bucket),
        budget,
      ).pipe(Effect.forkChild);
      yield* TestClock.adjust("1 second");
      return yield* Fiber.await(fiber);
    }).pipe(Effect.provide(TestClock.layer()), Effect.scoped),
  );
  assert.ok(Exit.isFailure(exit));
  const guard = refusalDiagnostic(exit.cause, "sql");
  assert.equal(guard.reasonCode, "time_bound");
  assert.equal(guard.elapsedMs, 1000);
  assert.equal(guard.objectClass, "split_record");
  assert.equal(gets, 1, "The remaining phase budget clips the first attempt and starts no retry");
});
