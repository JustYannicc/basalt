import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { Cause, Effect, Exit, Fiber } from "effect";
import { TestClock } from "effect/testing";
import { SqlClient } from "effect/sql";
import { pgliteLayer } from "../../.upstream/packages/fumadb-effect/src/pglite.ts";
import {
  bucketFixture,
  encoded,
  legacy,
  metadata,
  moduleText,
  nativeBody,
  nativeObject,
  record,
} from "./retained-frameworks-fixture.ts";

const upstream = new URL("../../.upstream/", import.meta.url);
const ops = (await import(
  new URL("apps/hosted/cloud/src/infrastructure/production-ops/inventory.ts", upstream).href
)) as typeof import("../../.upstream/apps/hosted/cloud/src/infrastructure/production-ops/inventory.ts");
const retained = (await import(
  new URL("apps/hosted/cloud/src/infrastructure/production-ops/retained-frameworks.ts", upstream)
    .href
)) as typeof import("../../.upstream/apps/hosted/cloud/src/infrastructure/production-ops/retained-frameworks.ts");
const r2 = (await import(
  new URL("apps/hosted/cloud/src/infrastructure/production-ops/retained-frameworks-r2.ts", upstream)
    .href
)) as typeof import("../../.upstream/apps/hosted/cloud/src/infrastructure/production-ops/retained-frameworks-r2.ts");
const contracts = (await import(
  new URL("apps/hosted/cloud/src/infrastructure/production-ops/contracts.ts", upstream).href
)) as typeof import("../../.upstream/apps/hosted/cloud/src/infrastructure/production-ops/contracts.ts");
const diagnostics = (await import(
  new URL("apps/hosted/cloud/src/infrastructure/production-ops/diagnostics.ts", upstream).href
)) as typeof import("../../.upstream/apps/hosted/cloud/src/infrastructure/production-ops/diagnostics.ts");
const identity = {
  version: "1.2.3",
  sha256: createHash("sha256")
    .update(JSON.stringify([["node_modules/apps/server.js", "synthetic framework"]]))
    .digest("hex"),
};
const reference = (build = "bld_one") => [{ app: "app_one", deployment: "dpl_one", build }];
const run = (fixture: ReturnType<typeof bucketFixture>, refs: unknown = reference()) =>
  Effect.runPromise(
    retained
      .retainedFrameworks(refs, r2.retainedFrameworkObjects(fixture.bucket))
      .pipe(Effect.provide(fixture.logger)),
  );

test("the fixed SQL scopes all retained deployments and R2 returns metadata without source", async () => {
  const fixture = bucketFixture();
  fixture.objects.push(metadata(identity.version, identity.sha256));
  fixture.bodies.set("bld_one/worker.json", encoded(record(identity)));
  fixture.bodies.set("bld_old.json", encoded(legacy()));
  fixture.bodies.set("bld_explicit.json", encoded(legacy(1)));
  const result = await Effect.runPromise(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`create table executor_apps (id text primary key, code text, owner text, name text)`;
      yield* sql`create table executor_deployments (id text primary key, code text, owner text, build text)`;
      yield* sql`insert into executor_apps values
      ('app_one', 'code_one', 'organization:org_one', ${moduleText}),
      ('app_copy', 'code_one', 'organization:org_one', ${moduleText}),
      ('app_foreign', 'code_foreign', 'organization:org_other', ${moduleText})`;
      yield* sql`insert into executor_deployments values
      ('dpl_one', 'code_one', 'organization:org_one', 'bld_one'),
      ('dpl_old', 'code_one', 'organization:org_one', 'bld_old'),
      ('dpl_explicit', 'code_one', 'organization:org_one', 'bld_explicit'),
      ('dpl_foreign', 'code_foreign', 'organization:org_other', 'bld_foreign'),
      ('dpl_wrong_owner', 'code_one', 'organization:org_other', 'bld_wrong_owner')`;
      yield* sql`begin transaction read only`;
      const inventory = yield* ops.inventory(
        "retained-frameworks",
        "org_one",
        r2.retainedFrameworkObjects(fixture.bucket),
      );
      yield* sql`rollback`;
      return inventory;
    }).pipe(Effect.provide(pgliteLayer()), Effect.provide(fixture.logger), Effect.scoped),
  );
  assert.ok("complete" in result && result.complete);
  assert.deepEqual(result.rows, [
    {
      version: identity.version,
      sha256: identity.sha256,
      protocol: 1,
      apps: ["app_copy", "app_one"],
      deployments: 3,
    },
  ]);
  assert.ok("builds" in result && result.builds.length === 3);
  assert.deepEqual(fixture.reads, [
    "bld_explicit/worker.json",
    "bld_explicit.json",
    "bld_old/worker.json",
    "bld_old.json",
    "bld_one/worker.json",
  ]);
  assert.deepEqual(fixture.lists, [{ prefix: "frameworks/", limit: 1000 }]);
  assert.ok("frameworks" in result);
  assert.deepEqual(result.frameworks, [
    {
      key: fixture.objects[0]!.key,
      size: 123,
      etag: "synthetic-etag",
      uploaded: "2026-11-01T00:00:00.000Z",
    },
  ]);
  for (const secret of [
    moduleText,
    "synthetic framework",
    "app_foreign",
    "wrong_owner",
    "modules",
    "secret",
  ])
    assert.ok(!JSON.stringify({ result, logs: fixture.logs }).includes(secret), secret);
  assert.equal(fixture.writes(), 0);
});

test("missing, unreadable, malformed and ambiguous builds remain explicitly incomplete", async () => {
  for (const kind of [
    "missing",
    "unreadable",
    "malformed",
    "absent-framework",
    "ambiguous",
    "no-modules",
  ] as const) {
    const fixture = bucketFixture();
    fixture.objects.push(metadata(identity.version, identity.sha256));
    let reason: string;
    switch (kind) {
      case "missing":
        reason = "missing_record";
        break;
      case "unreadable":
        fixture.bucket.get = () => Effect.fail(new Error(moduleText));
        reason = "unreadable_record";
        break;
      case "malformed":
        fixture.bodies.set("bld_one/worker.json", new TextEncoder().encode(moduleText));
        fixture.bodies.set("bld_one.json", encoded(legacy()));
        reason = "malformed_record";
        break;
      case "absent-framework":
        fixture.bodies.set(
          "bld_one/worker.json",
          encoded(record({ ...identity, sha256: "a".repeat(64) })),
        );
        reason = "missing_framework";
        break;
      case "ambiguous":
        fixture.objects.push(metadata("1.2.4", identity.sha256));
        fixture.bodies.set("bld_one.json", encoded(legacy()));
        reason = "ambiguous_framework";
        break;
      case "no-modules":
        fixture.bodies.set(
          "bld_one.json",
          encoded({ mainModule: "app.js", modules: { "app.js": moduleText }, database: false }),
        );
        reason = "missing_framework_modules";
        break;
    }
    const result = await run(fixture);
    assert.equal(result.complete, false, kind);
    assert.deepEqual(result.rows, [], kind);
    assert.deepEqual(
      result.builds,
      [{ build: "bld_one", apps: ["app_one"], deployments: ["dpl_one"], complete: false, reason }],
      kind,
    );
    assert.ok(!JSON.stringify({ result, logs: fixture.logs }).includes(moduleText));
    if (kind === "malformed")
      assert.deepEqual(
        fixture.reads,
        ["bld_one/worker.json"],
        "No fallback hides a broken split record",
      );
    assert.equal(fixture.writes(), 0);
  }
});

test("malformed R2 metadata and count, size and stream limits fail with a typed safe refusal", async () => {
  const cases = [
    (fixture: ReturnType<typeof bucketFixture>) => {
      fixture.objects.push(metadata("../bad", identity.sha256));
    },
    (fixture: ReturnType<typeof bucketFixture>) => {
      fixture.objects.push(
        ...Array.from({ length: 2001 }, () => metadata("1.2.3", identity.sha256)),
      );
    },
    (fixture: ReturnType<typeof bucketFixture>) => {
      fixture.bucket.get = () =>
        Effect.succeed(nativeObject(8_000_001, nativeBody(new Uint8Array())));
    },
    (fixture: ReturnType<typeof bucketFixture>) => {
      fixture.bucket.get = () =>
        Effect.succeed(nativeObject(1, nativeBody(new Uint8Array(8_000_001))));
    },
  ];
  for (const setup of cases) {
    const fixture = bucketFixture();
    setup(fixture);
    const exit = await Effect.runPromiseExit(
      retained
        .retainedFrameworks(reference(), r2.retainedFrameworkObjects(fixture.bucket))
        .pipe(Effect.provide(fixture.logger)),
    );
    assert.ok(Exit.isFailure(exit));
    const error = Cause.findErrorOption(exit.cause);
    assert.ok(error._tag === "Some" && error.value instanceof contracts.ProductionOperationRefused);
    assert.equal(diagnostics.diagnostic(exit.cause, "sql").category, "refused");
    assert.ok(
      !JSON.stringify({
        exit,
        logs: fixture.logs,
        diagnostic: diagnostics.refusalDiagnostic(exit.cause, "sql"),
      }).includes(moduleText),
    );
    assert.equal(fixture.writes(), 0);
  }
});

test("reference bounds and unsafe build paths refuse before reading any record body", async () => {
  for (const refs of [
    reference("bld_../source"),
    Array.from({ length: 2001 }, () => reference()[0]),
  ]) {
    const fixture = bucketFixture();
    await assert.rejects(run(fixture, refs), /Retained frameworks/);
    assert.deepEqual(fixture.reads, []);
  }
});

test("the total record byte bound prevents a fifth full record read", async () => {
  const fixture = bucketFixture();
  fixture.objects.push(metadata(identity.version, identity.sha256));
  const body = new TextEncoder().encode(JSON.stringify(record(identity)).padEnd(8_000_000, " "));
  const refs = Array.from({ length: 5 }, (_, index) => ({
    app: "app_one",
    deployment: `dpl_${index}`,
    build: `bld_${index}`,
  }));
  refs.forEach(({ build }) => fixture.bodies.set(`${build}/worker.json`, body));
  await assert.rejects(run(fixture, refs), /total byte bound/);
  assert.equal(fixture.reads.length, 4);
});

test("failed partial streams retain their cumulative byte reservations", async () => {
  const fixture = bucketFixture();
  const partial = new Uint8Array(7_000_000);
  let delivered = 0;
  let gets = 0;
  fixture.bucket.get = () => {
    gets++;
    let sent = false;
    const readable = new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          if (sent) controller.error(new Error(moduleText));
          else {
            sent = true;
            delivered += partial.byteLength;
            controller.enqueue(partial);
          }
        },
      },
      { highWaterMark: 0 },
    );
    return Effect.succeed(nativeObject(8_000_000, readable));
  };
  const refs = Array.from({ length: 5 }, (_, index) => ({
    app: "app_one",
    deployment: `dpl_${index}`,
    build: `bld_${index}`,
  }));
  const exit = await Effect.runPromiseExit(
    retained
      .retainedFrameworks(refs, r2.retainedFrameworkObjects(fixture.bucket))
      .pipe(Effect.provide(fixture.logger)),
  );
  assert.ok(Exit.isFailure(exit));
  const error = Cause.findErrorOption(exit.cause);
  assert.ok(error._tag === "Some" && error.value instanceof contracts.ProductionOperationRefused);
  assert.equal(error.value.message, "Retained frameworks: total byte bound");
  assert.equal(gets, 4, "A fifth failed stream cannot bypass the total allowance");
  assert.equal(delivered, 28_000_000);
  assert.ok(!JSON.stringify({ exit, logs: fixture.logs }).includes(moduleText));
});

test(
  "a native cancel promise that never settles cannot hold the time bound open",
  { timeout: 5000 },
  async () => {
    const fixture = bucketFixture();
    const started = Promise.withResolvers<void>();
    const neverCancelled = Promise.withResolvers<void>();
    let cancels = 0;
    const readable = new ReadableStream<Uint8Array>(
      {
        pull() {
          started.resolve();
        },
        cancel() {
          cancels++;
          return neverCancelled.promise;
        },
      },
      { highWaterMark: 0 },
    );
    fixture.bucket.get = () => Effect.succeed(nativeObject(1, readable));
    const exit = await Effect.runPromise(
      Effect.gen(function* () {
        const fiber = yield* retained
          .retainedFrameworks(reference(), r2.retainedFrameworkObjects(fixture.bucket))
          .pipe(Effect.forkChild);
        yield* Effect.promise(() => started.promise);
        yield* TestClock.adjust("8 seconds");
        return yield* Fiber.await(fiber);
      }).pipe(Effect.provide(TestClock.layer()), Effect.provide(fixture.logger), Effect.scoped),
    );
    assert.ok(Exit.isFailure(exit));
    const error = Cause.findErrorOption(exit.cause);
    assert.ok(error._tag === "Some" && error.value instanceof contracts.ProductionOperationRefused);
    assert.equal(error.value.message, "Retained frameworks: time bound");
    assert.equal(cancels, 1);
    assert.equal(readable.locked, false);
    assert.ok(!JSON.stringify({ exit, logs: fixture.logs }).includes(moduleText));
  },
);

test("the fixed time bound covers a stalled get and a stalled record body", async () => {
  for (const stalledBody of [false, true]) {
    const fixture = bucketFixture();
    let finalized = false;
    fixture.bucket.get = () =>
      stalledBody
        ? Effect.succeed(
            nativeObject(
              1,
              new ReadableStream<Uint8Array>({
                cancel() {
                  finalized = true;
                },
              }),
            ),
          )
        : Effect.never;
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const fiber = yield* retained
          .retainedFrameworks(reference(), r2.retainedFrameworkObjects(fixture.bucket))
          .pipe(Effect.forkChild);
        yield* TestClock.adjust("8 seconds");
        return yield* Fiber.await(fiber);
      }).pipe(Effect.provide(TestClock.layer()), Effect.scoped),
    );
    assert.ok(Exit.isFailure(result));
    assert.match(Cause.pretty(result.cause), /Retained frameworks: time bound/);
    assert.ok(!JSON.stringify({ result, logs: fixture.logs }).includes(moduleText));
    if (stalledBody) assert.ok(finalized, "Timeout finalizes the in-flight body read");
  }
});

test("aborting the inventory cancels its native body and starts no further reads", async () => {
  const fixture = bucketFixture();
  const started = Promise.withResolvers<void>();
  const cancelled = Promise.withResolvers<void>();
  const native = new ReadableStream<Uint8Array>({
    pull() {
      started.resolve();
    },
    cancel() {
      cancelled.resolve();
    },
  });
  let gets = 0;
  fixture.bucket.get = () => {
    gets++;
    return Effect.succeed(nativeObject(1, native));
  };
  const controller = new AbortController();
  const result = Effect.runPromiseExit(
    retained
      .retainedFrameworks(reference(), r2.retainedFrameworkObjects(fixture.bucket))
      .pipe(Effect.provide(fixture.logger)),
    { signal: controller.signal },
  );
  await started.promise;
  controller.abort();
  const exit = await result;
  await cancelled.promise;
  assert.ok(Exit.isFailure(exit));
  assert.equal(gets, 1);
  assert.ok(!JSON.stringify({ exit, logs: fixture.logs }).includes(moduleText));
});

test("every R2 metadata page contributes to completeness and broken cursors refuse", async () => {
  for (const broken of [false, true]) {
    const fixture = bucketFixture();
    fixture.bodies.set("bld_one/worker.json", encoded(record(identity)));
    const cursors: (string | undefined)[] = [];
    fixture.bucket.list = (options) =>
      Effect.sync(() => {
        cursors.push(options.cursor);
        return options.cursor === undefined
          ? { objects: [], truncated: true, cursor: "next" }
          : broken
            ? { objects: [], truncated: true, cursor: "next" }
            : { objects: [metadata(identity.version, identity.sha256)], truncated: false };
      });
    if (broken) await assert.rejects(run(fixture), /invalid metadata cursor/);
    else assert.equal((await run(fixture)).complete, true);
    assert.deepEqual(cursors, [undefined, "next"]);
  }
});

test("an oversized record header cancels its unread native body", async () => {
  const fixture = bucketFixture();
  const cancelled = Promise.withResolvers<void>();
  const native = new ReadableStream<Uint8Array>({
    cancel() {
      cancelled.resolve();
    },
  });
  fixture.bucket.get = () => Effect.succeed(nativeObject(8_000_001, native));
  await assert.rejects(run(fixture), /object byte bound/);
  await cancelled.promise;
  assert.ok(!JSON.stringify(fixture.logs).includes(moduleText));
});
