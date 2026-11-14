import assert from "node:assert/strict";
import { test } from "node:test";
import { Clock, Effect, Exit, Fiber, Schema } from "effect";
import { TestClock } from "effect/testing";
import { retainedFrameworks } from "../../.upstream/apps/hosted/cloud/src/infrastructure/production-ops/retained-frameworks.ts";
import { retainedFrameworkObjects } from "../../.upstream/apps/hosted/cloud/src/infrastructure/production-ops/retained-frameworks-r2.ts";
import { retainedFrameworkPageSize } from "../../.upstream/apps/hosted/cloud/src/infrastructure/production-ops/retained-frameworks-page-query.ts";
import { diagnostic } from "../../.upstream/apps/hosted/cloud/src/infrastructure/production-ops/diagnostics.ts";
import { retainedInventory } from "../production-ops/inventory-pagination.ts";
import { openEnvelope } from "../../src/pool/token.ts";
import {
  bucketFixture,
  encoded,
  metadata,
  nativeBody,
  nativeObject,
  record,
} from "./retained-frameworks-fixture.ts";

const identity = { version: "1.2.3", sha256: "a".repeat(64) };
const input = {
  target: "https://operator.example.test",
  signingKey: "ab".repeat(32),
  action: "inventory",
  mode: "dry-run",
  selection: "retained-frameworks",
  request: '{"organization":"org_one"}',
  recipient: "c3ludGhldGlj",
  planSha256: "",
  go: "",
};
const protection = (index: number) => ({
  version: 1,
  sha256: index.toString(16).padStart(64, "0"),
  sealed: {},
  recipient: {},
});

const page = (
  refs: { app: string; deployment: string; build: string }[],
  fixture: ReturnType<typeof bucketFixture>,
) =>
  Effect.gen(function* () {
    const startedAt = yield* Clock.currentTimeMillis;
    let elapsedMs = 0;
    const fiber = yield* retainedFrameworks(refs, retainedFrameworkObjects(fixture.bucket)).pipe(
      Effect.provide(fixture.logger),
      Effect.onExit(() =>
        Clock.currentTimeMillis.pipe(
          Effect.tap((now) =>
            Effect.sync(() => {
              elapsedMs = now - startedAt;
            }),
          ),
        ),
      ),
      Effect.forkChild,
    );
    yield* TestClock.adjust("18 seconds");
    const exit = yield* Fiber.await(fiber);
    return { exit, elapsedMs };
  }).pipe(Effect.provide(TestClock.layer()), Effect.scoped, Effect.runPromise);

for (const count of [329, 987])
  test(`${count} records at 250 ms finish through bounded pages without repeating a completed build`, async (t) => {
    const refs = Array.from({ length: count }, (_, i) => ({
      app: "app_one",
      deployment: `dpl_${i}`,
      build: `bld_${i}`,
    }));
    const fixture = bucketFixture();
    fixture.objects.push(metadata(identity.version, identity.sha256));
    const bytes = encoded(record(identity));
    const reads: string[] = [];
    let active = 0;
    let maximumActive = 0;
    let calls = 0;
    let maxElapsed = 0;
    fixture.bucket.get = (key) =>
      Effect.acquireUseRelease(
        Effect.sync(() => {
          reads.push(key);
          active++;
          maximumActive = Math.max(maximumActive, active);
        }),
        () =>
          Effect.sleep("250 millis").pipe(
            Effect.map(() => nativeObject(bytes.length, nativeBody(bytes))),
          ),
        () =>
          Effect.sync(() => {
            active--;
          }),
      );
    const fetcher: typeof fetch = async (_url, init) => {
      const signed = Schema.decodeUnknownSync(
        Schema.Struct({
          operation: Schema.Struct({
            action: Schema.String,
            continuation: Schema.optionalKey(Schema.Unknown),
          }),
        }),
      )(await openEnvelope(input.signingKey, "sbops1", JSON.parse(String(init!.body)).envelope));
      assert.equal(signed.operation.action, "inventory");
      const index = calls++;
      assert.deepEqual(signed.operation.continuation, index ? protection(index) : undefined);
      const subset = refs.slice(
        index * retainedFrameworkPageSize,
        (index + 1) * retainedFrameworkPageSize,
      );
      assert.ok(subset.length > 0 && subset.length <= 64);
      const result = await page(subset, fixture);
      assert.ok(Exit.isSuccess(result.exit));
      assert.equal(result.exit.value.complete, true);
      maxElapsed = Math.max(maxElapsed, result.elapsedMs);
      const more = (index + 1) * retainedFrameworkPageSize < count;
      return Response.json({
        action: "inventory",
        artifact: protection(1000 + index),
        pagination: {
          index,
          session: "fixture",
          more,
          complete: true,
          builds: subset.length,
          references: subset.length,
        },
        ...(more ? { continuation: protection(index + 1) } : {}),
      });
    };
    const result = await retainedInventory(input, fetcher);
    assert.equal(result.complete, true);
    assert.equal(result.builds, count);
    assert.equal(result.pages, Math.ceil(count / 64));
    assert.equal(reads.length, count);
    assert.equal(new Set(reads).size, count);
    assert.equal(maximumActive, 4);
    assert.equal(active, 0);
    assert.equal(fixture.writes(), 0);
    assert.ok(maxElapsed < 12000);
    t.diagnostic(JSON.stringify({ count, pages: result.pages, maxElapsed, maximumActive }));
  });

test("a hung page read refuses by its original attempt bound and returns the named failure", async () => {
  const fixture = bucketFixture();
  fixture.objects.push(metadata(identity.version, identity.sha256));
  fixture.bucket.get = () => Effect.never;
  const result = await page([{ app: "app_one", deployment: "dpl_one", build: "bld_one" }], fixture);
  assert.ok(Exit.isFailure(result.exit));
  assert.ok(result.elapsedMs < 10000);
  assert.equal(diagnostic(result.exit.cause, "sql").reasonCode, "read_timeout");
});

test("a page refusal stops the operator without repeating or requesting another page", async () => {
  let calls = 0;
  const saved: number[] = [];
  const fetcher: typeof fetch = async () => {
    const index = calls++;
    if (index === 1)
      return Response.json(
        {
          failure: {
            format: "basalt-production-ops-failure-v1",
            category: "refused",
            phase: "sql",
            reasonCode: "time_bound",
          },
        },
        { status: 409 },
      );
    return Response.json({
      action: "inventory",
      artifact: protection(1000),
      pagination: {
        index,
        session: "fixture",
        more: true,
        complete: true,
        builds: 64,
        references: 64,
      },
      continuation: protection(1),
    });
  };
  await assert.rejects(
    retainedInventory(input, fetcher, (_r, i) => {
      saved.push(i);
    }),
    (e: unknown) =>
      typeof e === "object" &&
      e !== null &&
      "receipt" in e &&
      JSON.stringify(e.receipt).includes('"reasonCode":"time_bound"'),
  );
  assert.equal(calls, 2);
  assert.deepEqual(saved, [0]);
});
