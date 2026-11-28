import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { Effect, Layer, Option, Redacted } from "effect";
import { HttpRouter, HttpServer } from "effect/http";
import { SqlClient } from "effect/sql";
import { TestClock } from "effect/testing";
import { pgliteLayer } from "../../.upstream/packages/fumadb-effect/src/pglite.ts";
import {
  AcceptancePoolRefused,
  type AcceptancePoolSteps,
  type Json,
} from "../../.upstream/apps/hosted/server/src/contracts/acceptance-pool.ts";
import { GroupDatabase } from "../../.upstream/apps/hosted/server/src/contracts/groups.ts";
import { ProductAnalytics } from "../../.upstream/apps/hosted/server/src/contracts/product-analytics.ts";
import {
  openEnvelope,
  signEnvelope,
} from "../../.upstream/apps/hosted/server/src/implementation/pool-token.ts";
import {
  migrateProductionOps,
  migrateProductionOpsDatabaseIdentity,
} from "../../.upstream/apps/hosted/cloud/src/infrastructure/production-ops/schema.ts";
import {
  acceptanceLeaseMs,
  acceptancePoolPath,
  type Operation,
} from "../../.upstream/apps/hosted/cloud/src/infrastructure/acceptance-pool/contracts.ts";
import {
  openSignedRequest,
  upstreamOriginSha256,
} from "../../.upstream/apps/hosted/cloud/src/infrastructure/acceptance-pool/guard.ts";
import { acceptancePoolHandler } from "../../.upstream/apps/hosted/cloud/src/infrastructure/acceptance-pool/http.ts";
import {
  claimReceipt,
  updateReceipt,
} from "../../.upstream/apps/hosted/cloud/src/infrastructure/acceptance-pool/receipt.ts";
import {
  runAcceptancePool,
  type RunnerSettings,
} from "../../.upstream/apps/hosted/cloud/src/infrastructure/acceptance-pool/runner.ts";
import { upstreamOriginSha256 as driverDigest } from "../acceptance-pool/client.ts";

const key = "ab".repeat(32);
const target = "https://app.example.test";
const host = "upstream.example.test";
const digest = upstreamOriginSha256(`https://${host}`);
const upstreamKey = "k".repeat(40);
const settings = (overrides: Partial<RunnerSettings> = {}): RunnerSettings => ({
  target,
  release: "release-a",
  encryptionKey: "cd".repeat(32),
  databaseOrigin: { host: "db.example.test", port: 5432, database: "postgres" },
  upstreamHost: host,
  ...overrides,
});
const setupRequest = {
  pool: "acceptance-run-1",
  accounts: [
    { profile: "a", method: "anthropic", models: "model-a" },
    { profile: "b", method: "openai", models: "model-b" },
  ],
} satisfies Json;

const recipient = await (async () => {
  const pair = await crypto.subtle.generateKey(
    {
      name: "RSA-OAEP",
      modulusLength: 3072,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["encrypt", "decrypt"],
  );
  return Buffer.from(await crypto.subtle.exportKey("spki", pair.publicKey)).toString("base64");
})();

/** Stand-in steps over one precondition row, so what is tested is the runner's own rules. */
const fixtureSteps = (log: string[], failOnce = new Set<string>()): AcceptancePoolSteps => ({
  inspect: () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const rows = yield* sql<{ value: string }>`select value from fixture_state where id = 'pre'`;
      return {
        observed: { precondition: rows[0]?.value ?? "absent" },
        steps: ["first", "second", "third"],
        writes: [{ store: "tools", table: "fixture", key: "one", action: "insert" }],
        data: { fixed: "id-1" },
      };
    }),
  run: (step) =>
    Effect.suspend(() => {
      log.push(step);
      if (failOnce.delete(step)) return Effect.fail(new Error("stand-in step failed"));
      return Effect.succeed({ done: step });
    }),
  verify: (context) =>
    Effect.succeed({
      ok: true,
      checks: { allSteps: ["first", "second", "third"].every((step) => step in context.progress) },
    }),
  describe: () => ({ app: null, accounts: [] }),
});

const signed = (operation: Operation, id: string = randomUUID()) => ({
  version: 1 as const,
  id,
  target,
  at: 0,
  expiresAt: 60_000,
  operation,
});

const refusal = (error: unknown) => {
  assert.ok(error instanceof AcceptancePoolRefused, `expected a refusal, got ${String(error)}`);
  return error.reason;
};

const database = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* migrateProductionOps;
  yield* migrateProductionOpsDatabaseIdentity;
  yield* sql`create table fixture_state (id text primary key, value text)`;
  yield* sql`insert into fixture_state values ('pre', 'one')`;
  return sql;
});

interface ReceiptRow {
  readonly plan_sha256: string;
  readonly migration: string;
  readonly backup_sha256: string;
  readonly verification: {
    readonly steps: Record<string, unknown>;
    readonly envelopes: string[];
    readonly lease: unknown;
  };
}
const receipts = Effect.flatMap(
  SqlClient.SqlClient,
  (sql) =>
    sql<ReceiptRow>`select plan_sha256, migration, backup_sha256, verification
      from private_production_ops_receipts order by migration`,
);

const runner = <A, E>(body: Effect.Effect<A, E, SqlClient.SqlClient>) =>
  Effect.runPromise(
    body.pipe(
      Effect.provide(TestClock.layer()),
      Effect.provide(pgliteLayer()),
      Effect.provide(NodeCrypto.layer),
    ),
  );

const dryRun = (steps: AcceptancePoolSteps, overrides: Partial<Operation> = {}, s = settings()) =>
  runAcceptancePool(
    s,
    signed({
      kind: "setup",
      action: "dry-run",
      request: setupRequest,
      recipient,
      upstreamOriginSha256: digest,
      ...overrides,
    }),
    steps,
  );

const applyOf = (planned: {
  readonly artifact: NonNullable<Operation["artifact"]>;
  readonly planSha256: string;
}): Operation => ({
  kind: "setup",
  action: "apply",
  request: setupRequest,
  artifact: planned.artifact,
  planSha256: planned.planSha256,
  go: `GO ${planned.planSha256}`,
  upstreamOriginSha256: digest,
  upstreamKey,
});

const apply = (operation: Operation, steps: AcceptancePoolSteps, s = settings()) =>
  runAcceptancePool(s, signed(operation), steps);

test("the guard opens only its own kind, signed with the current key, for this target, in its window", async () => {
  const now = 1_000_000;
  const payload = (overrides: Record<string, unknown> = {}) => ({
    version: 1,
    id: "request-1",
    target,
    at: now,
    expiresAt: now + 60_000,
    operation: { kind: "setup", action: "dry-run", request: setupRequest, recipient },
    ...overrides,
  });
  const open = (envelope: string, at = now) => openSignedRequest(key, envelope, at, target);
  const sign = (overrides: Record<string, unknown> = {}, prefix = "sbacc1", secret = key) =>
    signEnvelope(secret, prefix, payload(overrides));
  const valid = await sign();
  assert.ok(await open(valid), "a valid envelope opens");
  // Each bound refuses one past its edge and admits the edge itself.
  assert.equal(await open(await sign({}, "sbops1")), undefined, "production-ops' kind");
  assert.equal(
    await openEnvelope(key, "sbops1", valid),
    undefined,
    "this kind on production-ops' opener",
  );
  assert.equal(await open(await sign({}, "sbacc1", "ef".repeat(32))), undefined, "another key");
  assert.equal(
    await open(await sign({ target: "https://other.example.test" })),
    undefined,
    "another target",
  );
  assert.equal(await open(valid, now + 60_000), undefined, "expired at its edge");
  assert.ok(await open(valid, now + 59_999), "live just before");
  assert.equal(
    await open(await sign({ at: now + 5001, expiresAt: now + 6000 })),
    undefined,
    "too early",
  );
  assert.ok(await open(await sign({ at: now + 5000, expiresAt: now + 6000 })));
  assert.equal(await open(await sign({ expiresAt: now + 60_001 })), undefined, "lives too long");
  assert.equal(await open(await sign({ id: "i".repeat(129) })), undefined, "id too long");
  assert.ok(await open(await sign({ id: "i".repeat(128) })));
  const [prefix, , signature] = valid.split(".");
  const changed = Buffer.from(
    JSON.stringify(payload({ target: "https://other.example.test" })),
  ).toString("base64url");
  assert.equal(await open(`${prefix}.${changed}.${signature}`), undefined, "a changed payload");
});

const route = (signingKey = Option.some(Redacted.make(key))) =>
  Effect.gen(function* () {
    const sql = yield* database;
    const handler = acceptancePoolHandler({
      signingKey,
      target,
      settings: Effect.succeed(settings()),
      steps: fixtureSteps([]),
    });
    return HttpRouter.toWebHandler(
      HttpRouter.add("POST", acceptancePoolPath, handler).pipe(
        HttpRouter.provideRequest(Layer.succeed(GroupDatabase, Effect.succeed(sql))),
        Layer.provide(HttpServer.layerServices),
      ),
      { disableLogger: true },
    );
  });

const post = (server: { handler: (request: Request) => Promise<Response> }, body: string) =>
  Effect.promise(async () => {
    const response = await server.handler(
      new Request(`${target}${acceptancePoolPath}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
      }),
    );
    return { status: response.status, headers: response.headers, body: await response.json() };
  });
const envelope = (operation: Record<string, unknown>, prefix = "sbacc1") =>
  Effect.promise(() =>
    signEnvelope(key, prefix, {
      version: 1,
      id: randomUUID(),
      target,
      at: Date.now(),
      expiresAt: Date.now() + 60_000,
      operation,
    }).then((value) => JSON.stringify({ envelope: value })),
  );
const live = <A, E>(body: Effect.Effect<A, E, SqlClient.SqlClient>) =>
  Effect.runPromise(
    Effect.scoped(body.pipe(Effect.provide(pgliteLayer()), Effect.provide(NodeCrypto.layer))),
  );

test("the route answers only fixed bodies, and nothing before a valid envelope writes", () =>
  live(
    Effect.gen(function* () {
      const server = yield* route();
      const dry = {
        kind: "setup",
        action: "dry-run",
        request: setupRequest,
        recipient,
        upstreamOriginSha256: digest,
      };
      const tooLarge = yield* post(server, JSON.stringify({ envelope: "x".repeat(64 * 1024) }));
      assert.equal(tooLarge.status, 400);
      assert.deepEqual(tooLarge.body, {
        error: "acceptance_pool_refused",
        reason: "request_invalid",
        retryable: false,
      });
      const otherKind = yield* post(server, yield* envelope(dry, "sbops1"));
      assert.equal(otherKind.status, 401);
      assert.equal(otherKind.headers.get("cache-control"), "no-store");
      assert.deepEqual(otherKind.body, {
        error: "acceptance_pool_refused",
        reason: "unauthenticated",
        retryable: false,
      });
      const name = yield* post(
        server,
        yield* envelope({ ...dry, request: { ...setupRequest, pool: "people-pool" } }),
      );
      assert.equal(name.status, 409);
      assert.deepEqual(name.body, {
        error: "acceptance_pool_refused",
        reason: "name_pattern",
        retryable: false,
      });
      assert.equal((yield* receipts).length, 0);
      const planned = yield* post(server, yield* envelope(dry));
      assert.equal(planned.status, 200);
      assert.equal(planned.body.action, "dry-run");
      assert.equal(planned.body.upstreamConfigured, "yes");
      assert.match(String(planned.body.planSha256), /^[a-f0-9]{64}$/u);
      assert.equal((yield* receipts).length, 0, "a dry run writes no receipt");
    }),
  ));

test("the route without a signing key answers 503 and reads nothing", () =>
  live(
    Effect.gen(function* () {
      const response = yield* post(yield* route(Option.none()), "{}");
      assert.equal(response.status, 503);
      assert.deepEqual(response.body, { error: "acceptance_pool_unavailable" });
    }),
  ));

test("a name outside acceptance-<run> is refused before anything is read", () =>
  runner(
    Effect.gen(function* () {
      yield* database;
      for (const pool of [
        "people-pool",
        "acceptance-",
        "acceptance-Run",
        `acceptance-${"a".repeat(49)}`,
        "acceptance-run/1",
      ]) {
        const error = yield* Effect.flip(
          dryRun(fixtureSteps([]), { request: { ...setupRequest, pool } }),
        );
        assert.equal(refusal(error), "name_pattern", pool);
      }
      yield* dryRun(fixtureSteps([]), {
        request: { ...setupRequest, pool: `acceptance-${"a".repeat(48)}` },
      });
    }),
  ));

test("an apply needs the plan's own checksum and the exact GO for it", () =>
  runner(
    Effect.gen(function* () {
      yield* database;
      const log: string[] = [];
      const steps = fixtureSteps(log);
      const planned = yield* dryRun(steps);
      const other = "0".repeat(64);
      const refused = (operation: Operation) =>
        Effect.map(Effect.flip(apply(operation, steps)), refusal);
      assert.equal(yield* refused({ ...applyOf(planned), planSha256: other }), "checksum_mismatch");
      assert.equal(yield* refused({ ...applyOf(planned), go: `GO ${other}` }), "go_mismatch");
      assert.equal(yield* refused({ ...applyOf(planned), go: planned.planSha256 }), "go_mismatch");
      const { go: _, ...withoutGo } = applyOf(planned);
      assert.equal(yield* refused(withoutGo), "go_mismatch");
      assert.equal(
        yield* refused({
          ...applyOf(planned),
          artifact: { ...planned.artifact, sha256: other },
          planSha256: other,
          go: `GO ${other}`,
        }),
        "checksum_mismatch",
        "a plan whose bytes do not hash to its checksum",
      );
      assert.deepEqual(log, []);
      assert.equal((yield* receipts).length, 0);
    }),
  ));

test("a plan older than an hour, from another release, or whose preconditions moved, is stale and writes nothing", () =>
  runner(
    Effect.gen(function* () {
      const sql = yield* database;
      const log: string[] = [];
      const steps = fixtureSteps(log);
      const planned = yield* dryRun(steps);
      const refused = (s = settings()) =>
        Effect.map(Effect.flip(apply(applyOf(planned), steps, s)), refusal);
      yield* sql`update fixture_state set value = 'moved' where id = 'pre'`;
      assert.equal(yield* refused(), "stale_plan");
      yield* sql`update fixture_state set value = 'one' where id = 'pre'`;
      assert.equal(yield* refused(settings({ release: "release-b" })), "stale_plan");
      assert.equal(
        yield* refused(settings({ target: "https://other.example.test" })),
        "checksum_mismatch",
      );
      yield* TestClock.adjust(3_600_001);
      assert.equal(yield* refused(), "stale_plan");
      assert.deepEqual(log, []);
      assert.equal((yield* receipts).length, 0);
    }),
  ));

test("a replayed envelope is refused and writes nothing; a lost reply resumes with a new one", () =>
  runner(
    Effect.gen(function* () {
      yield* database;
      const log: string[] = [];
      const steps = fixtureSteps(log);
      const planned = yield* dryRun(steps);
      const first = signed(applyOf(planned));
      const applied = yield* runAcceptancePool(settings(), first, steps);
      assert.equal(applied.action, "apply");
      assert.deepEqual(log, ["first", "second", "third"]);
      const before = yield* receipts;
      assert.equal(before.length, 1);
      assert.equal(before[0]?.migration, "acceptance-pool-setup-v1");
      assert.ok(!JSON.stringify(before).includes(upstreamKey), "the key never reaches the receipt");
      assert.equal(
        refusal(yield* Effect.flip(runAcceptancePool(settings(), first, steps))),
        "replayed",
      );
      assert.deepEqual(yield* receipts, before, "a replay changes nothing");
      // The reply to `first` was lost: the driver signs a new envelope for the same plan and GO.
      const again = yield* apply(applyOf(planned), steps);
      assert.equal("repeated" in again && again.repeated, true);
      assert.deepEqual(log, ["first", "second", "third"], "no step runs twice");
    }),
  ));

test("an interrupted apply gives back its lease, and the next one resumes after the last recorded step", () =>
  runner(
    Effect.gen(function* () {
      yield* database;
      const log: string[] = [];
      const steps = fixtureSteps(log, new Set(["second"]));
      const planned = yield* dryRun(steps);
      const error = yield* Effect.flip(apply(applyOf(planned), steps));
      assert.equal(refusal(error), "step_failed");
      assert.equal((error as AcceptancePoolRefused).step, "second");
      const [row] = yield* receipts;
      assert.equal(row?.verification.lease, null);
      assert.deepEqual(Object.keys(row?.verification.steps ?? {}), ["first"]);
      const resumed = yield* apply(applyOf(planned), steps);
      assert.equal("resumed" in resumed && resumed.resumed, true);
      assert.deepEqual(log, ["first", "second", "second", "third"]);
    }),
  ));

test("a live lease is never taken; once it runs out another apply takes over and resumes, and the old holder is fenced off", () =>
  runner(
    Effect.gen(function* () {
      const sql = yield* database;
      const log: string[] = [];
      const steps = fixtureSteps(log);
      const planned = yield* dryRun(steps);
      // A holder that recorded one step and then stopped answering, without giving its lease back.
      const holder = randomUUID();
      const claimed = yield* runAcceptancePool(settings(), signed(applyOf(planned), holder), {
        ...steps,
        run: (step) =>
          step === "first" ? steps.run(step, undefined as never) : Effect.die("holder stopped"),
      }).pipe(Effect.exit);
      assert.equal(claimed._tag, "Failure");
      yield* sql`update private_production_ops_receipts set verification = jsonb_set(verification,
        '{lease}', ${JSON.stringify({ envelope: holder, until: acceptanceLeaseMs })}::jsonb)`;
      const before = yield* receipts;
      const busy = () => Effect.map(Effect.flip(apply(applyOf(planned), steps)), refusal);
      assert.equal(yield* busy(), "operation_busy");
      assert.deepEqual(yield* receipts, before, "a refused claim changes nothing");
      yield* TestClock.adjust(acceptanceLeaseMs - 1);
      assert.equal(yield* busy(), "operation_busy", "a millisecond before it runs out");
      yield* TestClock.adjust(1);
      const taken = yield* apply(applyOf(planned), steps);
      assert.equal("resumed" in taken && taken.resumed, true);
      assert.deepEqual(log, ["first", "second", "third"], "the recorded step is not repeated");
      const fenced = yield* Effect.flip(
        updateReceipt({
          planSha256: planned.planSha256,
          kind: "setup",
          release: "release-a",
          observedSha256: before[0]!.backup_sha256,
          envelope: holder,
          now: acceptanceLeaseMs,
          change: (state) => state,
        }),
      );
      assert.equal(refusal(fenced), "operation_busy", "the old holder can no longer write");
    }),
  ));

test("a setup needs the deploy's upstream host, the workflow's matching digest and a key of the upstream's shape", () =>
  runner(
    Effect.gen(function* () {
      yield* database;
      const log: string[] = [];
      const steps = fixtureSteps(log);
      const refused = <A, E, R>(work: Effect.Effect<A, E, R>) =>
        Effect.map(Effect.flip(work), refusal);
      const unset = yield* dryRun(steps, {}, settings({ upstreamHost: undefined }));
      assert.equal(unset.upstreamConfigured, "no");
      assert.equal(
        yield* refused(dryRun(steps, { upstreamOriginSha256: "0".repeat(64) })),
        "upstream_differs",
      );
      assert.equal(
        yield* refused(dryRun(steps, { upstreamOriginSha256: undefined })),
        "upstream_differs",
      );
      assert.equal(
        yield* refused(apply(applyOf(unset), steps, settings({ upstreamHost: undefined }))),
        "upstream_unset",
      );
      assert.equal(
        yield* refused(
          apply(applyOf(unset), steps, settings({ upstreamHost: "https://upstream.example.test" })),
        ),
        "upstream_unset",
        "a value with a scheme is not a host",
      );
      const planned = yield* dryRun(steps);
      const { upstreamKey: _, ...withoutKey } = applyOf(planned);
      assert.equal(yield* refused(apply(withoutKey, steps)), "upstream_key_invalid");
      for (const bad of ["short", `${"k".repeat(40)}/`, "k".repeat(129)])
        assert.equal(
          yield* refused(apply({ ...applyOf(planned), upstreamKey: bad }, steps)),
          "upstream_key_invalid",
        );
      assert.deepEqual(log, []);
      assert.equal((yield* receipts).length, 0);
    }),
  ));

test("a teardown needs a recorded setup, and a setup never resumes once a teardown has claimed it", () =>
  runner(
    Effect.gen(function* () {
      yield* database;
      const log: string[] = [];
      const steps = fixtureSteps(log, new Set(["third"]));
      const teardownDry = (setup: string) =>
        runAcceptancePool(
          settings(),
          signed({ kind: "teardown", action: "dry-run", request: { setup }, recipient }),
          steps,
        );
      assert.equal(refusal(yield* Effect.flip(teardownDry("1".repeat(64)))), "setup_missing");
      const planned = yield* dryRun(steps);
      assert.equal(refusal(yield* Effect.flip(apply(applyOf(planned), steps))), "step_failed");
      const teardown = yield* teardownDry(planned.planSha256);
      yield* apply(
        {
          kind: "teardown",
          action: "apply",
          request: { setup: planned.planSha256 },
          artifact: teardown.artifact,
          planSha256: teardown.planSha256,
          go: `GO ${teardown.planSha256}`,
        },
        fixtureSteps([]),
      );
      assert.equal(refusal(yield* Effect.flip(apply(applyOf(planned), steps))), "pool_state");
    }),
  ));

test("the receipt claim itself refuses a live lease and a repeated id without writing", () =>
  runner(
    Effect.gen(function* () {
      yield* database;
      const claim = (envelope: string, now: number) =>
        claimReceipt({
          planSha256: "2".repeat(64),
          kind: "setup",
          release: "release-a",
          observedSha256: "3".repeat(64),
          request: setupRequest,
          data: {},
          envelope,
          now,
          guard: Effect.void,
          fresh: Effect.void,
        });
      assert.equal((yield* claim("a", 0)).outcome, "fresh");
      assert.equal(refusal(yield* Effect.flip(claim("a", acceptanceLeaseMs + 1))), "replayed");
      const before = yield* receipts;
      assert.equal(
        refusal(yield* Effect.flip(claim("b", acceptanceLeaseMs - 1))),
        "operation_busy",
      );
      assert.deepEqual(yield* receipts, before);
      assert.equal((yield* claim("b", acceptanceLeaseMs)).outcome, "resumed");
      const [row] = yield* receipts;
      assert.deepEqual(row?.verification.envelopes, ["a", "b"]);
    }),
  ));

test("the workflow's digest of the origin is the one the server builds from its own host", () => {
  assert.equal(driverDigest(`https://${host}`), digest);
  assert.equal(driverDigest(`https://${host}/`), digest);
  assert.notEqual(driverDigest("https://other.example.test"), digest);
});

test("nothing the route runs sees an enabled analytics sink, even when the request installed one", () =>
  live(
    Effect.gen(function* () {
      const sql = yield* database;
      const seen: boolean[] = [];
      const captured: unknown[] = [];
      const steps = fixtureSteps([]);
      const handler = acceptancePoolHandler({
        signingKey: Option.some(Redacted.make(key)),
        target,
        settings: Effect.succeed(settings()),
        steps: {
          ...steps,
          inspect: (...args) =>
            Effect.flatMap(ProductAnalytics, (sink) => {
              seen.push(sink.enabled);
              sink.capture({} as never);
              return steps.inspect(...args);
            }),
        },
      }).pipe(
        Effect.provideService(ProductAnalytics, {
          enabled: true,
          capture: (event) => {
            captured.push(event);
          },
          submitFeedback: () => Effect.void,
        }),
      );
      const server = HttpRouter.toWebHandler(
        HttpRouter.add("POST", acceptancePoolPath, handler).pipe(
          HttpRouter.provideRequest(Layer.succeed(GroupDatabase, Effect.succeed(sql))),
          Layer.provide(HttpServer.layerServices),
        ),
        { disableLogger: true },
      );
      const planned = yield* post(
        server,
        yield* envelope({
          kind: "setup",
          action: "dry-run",
          request: setupRequest,
          recipient,
          upstreamOriginSha256: digest,
        }),
      );
      assert.equal(planned.status, 200);
      assert.deepEqual(seen, [false]);
      assert.deepEqual(captured, []);
    }),
  ));
