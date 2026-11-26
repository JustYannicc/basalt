import assert from "node:assert/strict";
import { createServer } from "node:http";
import { test } from "node:test";
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import { Clock, ConfigProvider, Effect, Layer, Logger, Redacted, References } from "effect";
import { HttpRouter, HttpServer } from "effect/http";
import { SqlClient } from "effect/sql";
import { fumadb } from "../../.upstream/packages/fumadb-effect/src/index.ts";
import { pgliteLayer } from "../../.upstream/packages/fumadb-effect/src/pglite.ts";
import { schema } from "../../.upstream/packages/fumadb-effect/src/schema.ts";
import { sqlAdapter } from "../../.upstream/packages/fumadb-effect/src/sql.ts";
import type {
  AccountId,
  Executor,
  OwnerId,
  ProviderId,
} from "../../.upstream/packages/sdk/src/core.ts";
import { accountAcquisitions } from "../../.upstream/packages/sdk/src/implementation/account-acquisition-schema.ts";
import { nativeMembershipReadTimeoutMs } from "../../src/pool/native-contract.ts";
import { signEnvelope } from "../../src/pool/token.ts";

const load = (path: string) => import(new URL(`../../.upstream/${path}`, import.meta.url).href);
const sdk = (await load(
  "packages/sdk/src/core.ts",
)) as typeof import("../../.upstream/packages/sdk/src/core.ts");
const membership = (await load(
  "apps/hosted/server/src/implementation/pool-membership.ts",
)) as typeof import("../../.upstream/apps/hosted/server/src/implementation/pool-membership.ts");
const mirrors = (await load(
  "apps/hosted/server/src/implementation/pool-membership-mirrors.ts",
)) as typeof import("../../.upstream/apps/hosted/server/src/implementation/pool-membership-mirrors.ts");
const hostedExecutor = (await load(
  "apps/hosted/server/src/contracts/executor.ts",
)) as typeof import("../../.upstream/apps/hosted/server/src/contracts/executor.ts");
const groups = (await load(
  "apps/hosted/server/src/contracts/groups.ts",
)) as typeof import("../../.upstream/apps/hosted/server/src/contracts/groups.ts");
const signingKey = "ab".repeat(32);
const organization = "org_membership";
const pool = "app_membership";
const owner = `organization:${organization}`;
// The pool Worker's own limit on the membership read, as src/pool/membership-read.ts applies it.
const poolReadLimitMs = nativeMembershipReadTimeoutMs;
const acquisitionStorage = fumadb({
  namespace: "pool-membership-mirror-fixture",
  schemas: [schema({ version: "1.0.0", tables: { accountAcquisitions } })],
}).client(sqlAdapter({ provider: "postgresql" }));

/**
 * How one account's Home mirror answers: after `delayMs`, or never. `cleanupMs` is how long its
 * finalizer then runs, as the SDK's stale-mirror cleanup can wait on Home.
 */
type Mirror = {
  readonly outcome: "ok" | "binding" | "storage" | "defect" | "hang";
  readonly delayMs?: number;
  readonly cleanupMs?: number;
};
interface Options {
  /** How long each locked membership read, counted across the pool's reads, waits for its lock. */
  readonly lockWaitMs?: (read: number) => number;
}
interface Log {
  readonly message: unknown;
  readonly annotations: Readonly<Record<string, unknown>>;
}
interface Pool {
  /** One signed read through the real HTTP route: what it served, and how long it took. */
  readonly read: Effect.Effect<{ served: Record<string, string | null>; ms: number }>;
  readonly attempts: string[];
  readonly logs: Log[];
  /** Moves the host's clock forward; the request envelope follows it. */
  readonly advance: (ms: number) => void;
  readonly ready: Effect.Effect<ReadonlyArray<unknown>>;
  /** Every acquisition host a read was given: one per read, as each Worker event builds its own. */
  readonly executors: Set<object>;
  /** Links one more shared account to the pool. */
  readonly link: (account: string) => Effect.Effect<void>;
}

const binding = (account: string) => ({
  account: account as AccountId,
  owner: owner as OwnerId,
  provider: "prv_home" as ProviderId,
  method: "apiKey",
  driver: "basalt-home",
  driverRevision: "home-r1",
  generation: 1,
  revision: `binding-${account}`,
  removal: null,
});

/** One signed read through the real HTTP route, abandoned where the pool abandons it. */
async function signedRead(origin: string, offset: number) {
  const at = Date.now() + offset;
  const envelope = await signEnvelope(signingKey, "sbq1", {
    pool,
    organization,
    at,
    expiresAt: at + 30_000,
  });
  const started = performance.now();
  const response = await fetch(`${origin}${membership.poolMembershipReadPath}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ envelope }),
    // The pool abandons the read here, as membership-read.ts does.
    signal: AbortSignal.timeout(poolReadLimitMs),
  });
  assert.equal(response.status, 200);
  const body = (await response.json()) as {
    accounts: Array<{ account: string; homeReference: string | null }>;
  };
  return {
    served: Object.fromEntries(
      body.accounts.map((account) => [account.account, account.homeReference]),
    ),
    ms: performance.now() - started,
  };
}

const nativePool = (
  accounts: readonly string[],
  mirror: (account: string) => Mirror,
  run: (pool: Pool) => Effect.Effect<void>,
  options: Options = {},
) =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const migration = yield* (yield* acquisitionStorage.createMigrator).migrateToLatest();
        yield* migration.execute;
        for (const statement of [
          "create table organization (id text primary key, metadata text)",
          'create table member (id text primary key, "organizationId" text, "userId" text, role text)',
          "create table executor_apps (id text primary key, owner text, name text, active_deployment text)",
          "create table executor_deployments (id text primary key, requirements jsonb)",
          "create table hosted_account_access (account_id text primary key, organization_id text, kind text, personal_user_id text, creator_id text)",
          "create table hosted_app_account_links (app text, requirement text, subject text, account text, linked_by text not null, created_at timestamptz)",
          "create table executor_accounts (id text primary key, owner text, provider text, method text, credential_generation integer, encrypted_credentials bytea default decode('01','hex'))",
        ])
          yield* sql.unsafe(statement);
        const attempts: string[] = [];
        const logs: Log[] = [];
        const executors = new Set<object>();
        let lockedReads = 0;
        const makeExecutor = () => ({
          [sdk.StorageHost]: {
            transaction: <A, E, R>(effect: Effect.Effect<A, E, R>) =>
              Effect.suspend(() => {
                const wait = options.lockWaitMs?.(lockedReads++) ?? 0;
                return wait > 0 ? Effect.andThen(Effect.sleep(wait), effect) : effect;
              }),
          },
          [sdk.AccountAcquisitionHost]: {
            ensureMirror: ({ account }: { account: string }) =>
              Effect.gen(function* () {
                attempts.push(account);
                // The SDK saves a pending reference before it asks the backend.
                yield* sql`insert into executor_account_acquisitions
                  (account, owner, provider, method, generation, driver, driver_revision, revision,
                    removal, mirror_reference, mirror_ready, mirror_operation)
                  values (${account}, ${owner}, 'prv_home', 'apiKey', 1, 'basalt-home', 'home-r1',
                    ${`binding-${account}`}, null, decode('01', 'hex'), false, 'native-pool-link')
                  on conflict (account) do nothing`;
                const { outcome, delayMs = 0 } = mirror(account);
                if (delayMs > 0) yield* Effect.sleep(delayMs);
                if (outcome === "hang") return yield* Effect.never;
                if (outcome === "binding")
                  return yield* new sdk.AccountAcquisitionUnavailable({ reason: "binding" });
                if (outcome === "storage") return yield* new sdk.StorageError();
                if (outcome === "defect") return yield* Effect.die("Home answered something odd");
                yield* sql`update executor_account_acquisitions set mirror_ready = true
                  where account = ${account}`;
                return binding(account);
              }).pipe(Effect.ensuring(Effect.sleep(mirror(account).cleanupMs ?? 0))),
            // A pending reference resolves too, so only the read's own exclusion keeps it out.
            source: ({ account }: { account: string }) =>
              Effect.gen(function* () {
                const saved = yield* sql`select 1 from executor_account_acquisitions
                  where account = ${account}`;
                if (saved.length === 0) return undefined;
                return {
                  binding: binding(account),
                  source: { kind: "driver", id: "basalt-home", version: "home-r1" },
                  hostReference: Redacted.make(`home-ref-${account}`),
                  current: Effect.succeed(binding(account)),
                };
              }),
          },
        });
        // Production builds an executor for every Worker event and binds it to the isolate's one
        // acquisition registration and credential key; the fake does the same.
        const registration = {};
        const hosted = Effect.promise(async () => {
          // The fake implements only the hosts the membership read reaches.
          const executor = makeExecutor() as unknown as Executor;
          executors.add(executor[sdk.AccountAcquisitionHost]);
          await membership.bindPoolMembershipReferenceRuntime(
            executor,
            registration,
            Redacted.make(signingKey),
          );
          return executor;
        });
        yield* sql`insert into organization values (${organization}, ${JSON.stringify({
          basaltPools: { owner: { app: pool, membership: "executor-links-v1" } },
        })})`;
        yield* sql`insert into member values ('m-owner', ${organization}, 'owner', 'owner')`;
        yield* sql`insert into executor_apps values (${pool}, ${owner}, 'Pool', 'dpl_app')`;
        yield* sql`insert into executor_deployments values ('dpl_app', ${JSON.stringify({
          accounts: {
            home: {
              scope: "app",
              provider: "prv_home",
              cardinality: "many",
              definition: { name: "Model provider", auth: { apiKey: { type: "secrets" } } },
            },
          },
        })})`;
        const link = (account: string) =>
          Effect.gen(function* () {
            yield* sql`insert into hosted_account_access values
                (${account}, ${organization}, 'shared', null, 'owner')`;
            yield* sql`insert into executor_accounts values
                (${account}, ${owner}, 'prv_home', 'apiKey', 1)`;
            yield* sql`insert into hosted_app_account_links values
                (${pool}, 'home', null, ${account}, 'owner', now())`;
          }).pipe(Effect.orDie);
        for (const account of accounts) yield* link(account);
        const real = yield* Clock.Clock;
        let offset = 0;
        const shifted: Clock.Clock = {
          currentTimeMillisUnsafe: () => real.currentTimeMillisUnsafe() + offset,
          currentTimeMillis: Effect.sync(() => real.currentTimeMillisUnsafe() + offset),
          currentTimeNanosUnsafe: () => real.currentTimeNanosUnsafe() + BigInt(offset) * 1_000_000n,
          currentTimeNanos: Effect.sync(
            () => real.currentTimeNanosUnsafe() + BigInt(offset) * 1_000_000n,
          ),
          monotonicTimeNanosUnsafe: () => real.monotonicTimeNanosUnsafe(),
          monotonicTimeNanos: real.monotonicTimeNanos,
          sleep: (duration) => real.sleep(duration),
        };
        const capture = Logger.make(({ message, fiber }) => {
          logs.push({
            message: Array.isArray(message) ? message[0] : message,
            annotations: fiber.getRef(References.CurrentLogAnnotations),
          });
        });
        const services = yield* Layer.build(
          HttpRouter.serve(
            HttpRouter.add(
              "POST",
              membership.poolMembershipReadPath,
              membership.readNativePoolMembership,
            ),
            { disableLogger: true, disableListenLog: true },
          ).pipe(
            Layer.provide(
              Layer.mergeAll(
                Layer.succeed(hostedExecutor.HostedExecutor, hosted),
                Layer.succeed(groups.GroupDatabase, Effect.succeed(sql)),
                ConfigProvider.layer(
                  ConfigProvider.fromUnknown({ POOL_APP_SIGNING_KEY: signingKey }),
                ),
                Layer.succeed(Clock.Clock, shifted),
                Logger.layer([capture]),
              ),
            ),
            Layer.provideMerge(NodeHttpServer.layer(createServer, { host: "127.0.0.1", port: 0 })),
          ),
        );
        const server = yield* HttpServer.HttpServer.pipe(Effect.provideContext(services));
        if (!("port" in server.address)) return yield* Effect.die("Expected TCP listener");
        const origin = `http://127.0.0.1:${server.address.port}`;
        const read = Effect.tryPromise(() => signedRead(origin, offset)).pipe(Effect.orDie);
        const ready = sql`select account, mirror_ready as ready from executor_account_acquisitions
          order by account`.pipe(Effect.orDie);
        yield* run({
          read,
          attempts,
          logs,
          advance: (ms) => (offset += ms),
          ready,
          executors,
          link,
        });
      }),
    ).pipe(Effect.provide(pgliteLayer()), Effect.orDie),
  );

const warningLines = (logs: Log[]) =>
  logs
    .filter((log) => log.message === "Pool account could not be mirrored")
    .map(({ annotations }) => annotations);
const warnings = (logs: Log[]) =>
  warningLines(logs).map(({ account, reason }) => ({ account, reason }));
const restored = (logs: Log[]) =>
  logs
    .filter((log) => log.message === "Pool account mirrored again")
    .map(({ annotations }) => annotations.account);

test("an account that cannot be mirrored stays out while the pool's other accounts are mirrored and served", async () => {
  // Each way the one account's mirror can fail: a refused binding (a Cloudflare token that sees
  // several accounts, a Home write refusal), a storage failure and a defect in the driver.
  let refusal: Mirror["outcome"] = "binding";
  await nativePool(
    ["acc_good", "acc_bad", "acc_also_good"],
    (account) => ({ outcome: account === "acc_bad" ? refusal : "ok" }),
    (pool) =>
      Effect.gen(function* () {
        const seen: Array<{ account: unknown; reason: unknown }> = [];
        for (const cause of ["binding", "storage", "defect"] as const) {
          refusal = cause;
          pool.attempts.length = 0;
          assert.deepEqual((yield* pool.read).served, {
            acc_also_good: "home-ref-acc_also_good",
            acc_good: "home-ref-acc_good",
          });
          assert.ok(pool.attempts.includes("acc_bad"));
          // The read itself names the failing account with a closed reason.
          seen.push({ account: "acc_bad", reason: cause });
          assert.deepEqual(warnings(pool.logs), seen);
          assert.deepEqual(yield* pool.ready, [
            { account: "acc_also_good", ready: true },
            { account: "acc_bad", ready: false },
            { account: "acc_good", ready: true },
          ]);
          pool.advance(mirrors.poolMembershipMirrorRetryMs.last);
        }

        refusal = "ok";
        assert.deepEqual((yield* pool.read).served, {
          acc_also_good: "home-ref-acc_also_good",
          acc_bad: "home-ref-acc_bad",
          acc_good: "home-ref-acc_good",
        });
        assert.deepEqual(restored(pool.logs), ["acc_bad"]);
      }),
  );
});

test("a failed account waits out a doubling backoff before the next mirror attempt, across the executor each read builds", async () => {
  let refusal: Mirror["outcome"] = "binding";
  const { first } = mirrors.poolMembershipMirrorRetryMs;
  await nativePool(
    ["acc_good", "acc_bad"],
    (account) => ({ outcome: account === "acc_bad" ? refusal : "ok" }),
    (pool) =>
      Effect.gen(function* () {
        const attemptsOnBad = () => pool.attempts.filter((account) => account === "acc_bad").length;
        const servedOnlyGood = { acc_good: "home-ref-acc_good" };
        assert.deepEqual((yield* pool.read).served, servedOnlyGood);
        assert.equal(attemptsOnBad(), 1);

        // The first failure is always logged.
        assert.deepEqual(warningLines(pool.logs), [
          {
            pool: "app_membership",
            account: "acc_bad",
            reason: "binding",
            failures: 1,
            skipped: 0,
            retryInMs: first,
          },
        ]);

        // Within the first minute the account is neither tried nor served, and not logged again.
        assert.deepEqual((yield* pool.read).served, servedOnlyGood);
        pool.advance(first - 1_000);
        assert.deepEqual((yield* pool.read).served, servedOnlyGood);
        assert.equal(attemptsOnBad(), 1);
        assert.equal(warningLines(pool.logs).length, 1);

        // The next line, after the backoff, counts the two reads that left the account out.
        pool.advance(2_000);
        assert.deepEqual((yield* pool.read).served, servedOnlyGood);
        assert.equal(attemptsOnBad(), 2);
        assert.deepEqual(warningLines(pool.logs)[1], {
          pool: "app_membership",
          account: "acc_bad",
          reason: "binding",
          failures: 2,
          skipped: 2,
          retryInMs: 2 * first,
        });

        // The second failure waits twice as long.
        pool.advance(first + 1_000);
        yield* pool.read;
        assert.equal(attemptsOnBad(), 2);
        pool.advance(first);
        refusal = "ok";
        assert.deepEqual((yield* pool.read).served, {
          acc_bad: "home-ref-acc_bad",
          acc_good: "home-ref-acc_good",
        });
        assert.equal(attemptsOnBad(), 3);
        assert.deepEqual(restored(pool.logs), ["acc_bad"]);
        assert.equal(warningLines(pool.logs).length, 2);
        // Each of the six reads ran on its own new executor, as each Worker event builds one, so
        // the backoff and the counts above outlived every executor that recorded them.
        assert.equal(pool.executors.size, 6);
      }),
  );
});

test("however long an account has failed, it is served again within 5 minutes of being fixed", async () => {
  let refusal: Mirror["outcome"] = "binding";
  const { last } = mirrors.poolMembershipMirrorRetryMs;
  const minutes = 60_000;
  await nativePool(
    ["acc_good", "acc_bad"],
    (account) => ({ outcome: account === "acc_bad" ? refusal : "ok" }),
    (pool) =>
      Effect.gen(function* () {
        // Each failed attempt is tried again once its wait has passed.
        for (let attempt = 0; attempt < 9; attempt += 1) {
          yield* pool.read;
          const line = warningLines(pool.logs).at(-1)!;
          assert.equal(line.failures, attempt + 1);
          pool.advance(line.retryInMs as number);
        }
        assert.deepEqual(
          warningLines(pool.logs).map((line) => line.retryInMs),
          [1, 2, 4, 5, 5, 5, 5, 5, 5].map((wait) => wait * minutes),
        );

        // Its backend comes back just after an attempt: the account is served 5 minutes later.
        yield* pool.read;
        refusal = "ok";
        pool.advance(last - 1_000);
        assert.deepEqual(Object.keys((yield* pool.read).served), ["acc_good"]);
        pool.advance(1_000);
        assert.deepEqual((yield* pool.read).served, {
          acc_bad: "home-ref-acc_bad",
          acc_good: "home-ref-acc_good",
        });
      }),
  );
});

test("the mirror and answer budgets are derived from, and safely under, the pool's read deadline", () => {
  // Both run from the read's arrival; after the mirrors the read runs one more locked query.
  const { poolMembershipMirrorBudgetMs: mirrorsBy, poolMembershipAnswerBudgetMs: answerBy } =
    mirrors;
  assert.ok(mirrorsBy > 0);
  assert.ok(answerBy - mirrorsBy >= 2_000, `${answerBy - mirrorsBy} ms for the second read`);
  assert.ok(answerBy <= poolReadLimitMs - 1_000, `answer ${answerBy} ms of ${poolReadLimitMs} ms`);
});

test("slow accounts are mirrored side by side, within the pool's read limit", async () => {
  const slowMs = 2_500;
  await nativePool(
    ["acc_one", "acc_two", "acc_three"],
    () => ({ outcome: "ok", delayMs: slowMs }),
    (pool) =>
      Effect.gen(function* () {
        // One after another they would take 7.5 s, past the 6 s mirror budget.
        const { served, ms } = yield* pool.read;
        assert.deepEqual(served, {
          acc_one: "home-ref-acc_one",
          acc_three: "home-ref-acc_three",
          acc_two: "home-ref-acc_two",
        });
        assert.ok(ms < mirrors.poolMembershipMirrorBudgetMs, `read took ${ms} ms`);
        assert.deepEqual(warnings(pool.logs), []);
      }),
  );
});

test("a mirror that never answers costs the read its budget, not the pool", async () => {
  await nativePool(
    ["acc_good", "acc_hung", "acc_slow"],
    (account) =>
      account === "acc_hung"
        ? { outcome: "hang" }
        : { outcome: "ok", delayMs: account === "acc_slow" ? 1_500 : 0 },
    (pool) =>
      Effect.gen(function* () {
        const { served, ms } = yield* pool.read;
        assert.deepEqual(served, {
          acc_good: "home-ref-acc_good",
          acc_slow: "home-ref-acc_slow",
        });
        assert.ok(ms >= mirrors.poolMembershipMirrorBudgetMs - 50, `read took ${ms} ms`);
        assert.ok(ms < poolReadLimitMs - 2_000, `read took ${ms} ms`);
        assert.deepEqual(warnings(pool.logs), [{ account: "acc_hung", reason: "timeout" }]);
        // The pending reference stays for the next attempt to resume.
        assert.deepEqual(yield* pool.ready, [
          { account: "acc_good", ready: true },
          { account: "acc_hung", ready: false },
          { account: "acc_slow", ready: true },
        ]);

        // Backed off, the next read does not wait on it at all.
        const again = yield* pool.read;
        assert.deepEqual(Object.keys(again.served).sort(), ["acc_good", "acc_slow"]);
        assert.ok(again.ms < 2_000, `read took ${again.ms} ms`);
        assert.equal(pool.attempts.filter((account) => account === "acc_hung").length, 1);
      }),
  );
});

test("the budget runs from the read's arrival, so a slow first locked read still answers in time", async () => {
  const lockWaitMs = 4_500;
  await nativePool(
    ["acc_quick", "acc_slow", "acc_hung"],
    (account) =>
      account === "acc_hung"
        ? { outcome: "hang" }
        : { outcome: "ok", delayMs: account === "acc_slow" ? 1_000 : 0 },
    (pool) =>
      Effect.gen(function* () {
        // Counted from the end of the first locked read, the mirrors would run to 10.5 s, past
        // the point where the pool abandons the read.
        const { served, ms } = yield* pool.read;
        assert.deepEqual(served, {
          acc_quick: "home-ref-acc_quick",
          acc_slow: "home-ref-acc_slow",
        });
        assert.ok(ms >= lockWaitMs, `read took ${ms} ms`);
        assert.ok(ms < mirrors.poolMembershipMirrorBudgetMs + 1_000, `read took ${ms} ms`);
        assert.deepEqual(warnings(pool.logs), [{ account: "acc_hung", reason: "timeout" }]);
      }),
    { lockWaitMs: (read) => (read === 0 ? lockWaitMs : 0) },
  );
});

test("a second locked read that cannot finish in time gives way to the first", async () => {
  await nativePool(
    ["acc_first"],
    () => ({ outcome: "ok" }),
    (pool) =>
      Effect.gen(function* () {
        // Locked reads 0 and 1: the first account is mirrored and served.
        assert.deepEqual((yield* pool.read).served, { acc_first: "home-ref-acc_first" });
        yield* pool.link("acc_new");
        // Locked read 2 answers at once; read 3, after the new account mirrors, never would.
        const { served, ms } = yield* pool.read;
        assert.deepEqual(served, { acc_first: "home-ref-acc_first" });
        assert.ok(ms >= mirrors.poolMembershipAnswerBudgetMs - 50, `read took ${ms} ms`);
        assert.ok(ms < poolReadLimitMs - 500, `read took ${ms} ms`);
        // The account it mirrored is served by the next read.
        assert.deepEqual((yield* pool.read).served, {
          acc_first: "home-ref-acc_first",
          acc_new: "home-ref-acc_new",
        });
        assert.deepEqual(warnings(pool.logs), []);
      }),
    { lockWaitMs: (read) => (read === 3 ? 60_000 : 0) },
  );
});

test("a timed-out mirror's cleanup runs on after the answer instead of holding it", async () => {
  await nativePool(
    ["acc_good", "acc_hung"],
    (account) =>
      account === "acc_hung" ? { outcome: "hang", cleanupMs: 5_000 } : { outcome: "ok" },
    (pool) =>
      Effect.gen(function* () {
        // Waiting for the cleanup would take the read to 11 s.
        const { served, ms } = yield* pool.read;
        assert.deepEqual(served, { acc_good: "home-ref-acc_good" });
        assert.ok(ms < mirrors.poolMembershipMirrorBudgetMs + 1_000, `read took ${ms} ms`);
        assert.deepEqual(warnings(pool.logs), [{ account: "acc_hung", reason: "timeout" }]);
      }),
  );
});

test("an account cut off at the budget is logged once, counted after, and tried first next time", async () => {
  const { first } = mirrors.poolMembershipMirrorRetryMs;
  await nativePool(
    ["acc_1", "acc_2", "acc_3", "acc_4", "acc_5"],
    (account) => (account === "acc_5" ? { outcome: "ok" } : { outcome: "hang" }),
    (pool) =>
      Effect.gen(function* () {
        const lines = (account: string) =>
          warningLines(pool.logs).filter((line) => line.account === account);
        // Four hung accounts hold every mirror slot until the budget ends, so the fifth is cut off.
        assert.deepEqual((yield* pool.read).served, {});
        assert.deepEqual([...pool.attempts].sort(), ["acc_1", "acc_2", "acc_3", "acc_4"]);
        assert.deepEqual(lines("acc_5"), [
          {
            pool: "app_membership",
            account: "acc_5",
            reason: "timeout",
            failures: 0,
            skipped: 0,
            retryInMs: 0,
          },
        ]);
        // A first locked read past the mirror budget cuts it off again: counted, not logged.
        assert.deepEqual((yield* pool.read).served, {});
        assert.equal(pool.attempts.length, 4);
        assert.equal(lines("acc_5").length, 1);
        // Once the four are due again, the account never tried goes ahead of them and is served.
        pool.advance(first);
        assert.deepEqual((yield* pool.read).served, { acc_5: "home-ref-acc_5" });
        assert.equal(pool.attempts[4], "acc_5");
        assert.equal(lines("acc_5").length, 1);
        assert.deepEqual(
          pool.logs
            .filter((log) => log.message === "Pool account mirrored again")
            .map(({ annotations }) => annotations),
          [{ pool: "app_membership", account: "acc_5", failures: 0, skipped: 1 }],
        );
        assert.deepEqual(lines("acc_1").at(-1), {
          pool: "app_membership",
          account: "acc_1",
          reason: "timeout",
          failures: 2,
          skipped: 1,
          retryInMs: 2 * first,
        });
      }),
    { lockWaitMs: (read) => (read === 1 ? mirrors.poolMembershipMirrorBudgetMs + 100 : 0) },
  );
});
