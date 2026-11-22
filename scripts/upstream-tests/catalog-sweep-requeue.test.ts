import assert from "node:assert/strict";
import { test } from "node:test";
import { Effect } from "effect";
import { SqlClient } from "effect/sql";
import { job, version1, version2, withScenario } from "./catalog-resource-retry-fixture.ts";

const upstream = new URL("../../.upstream/", import.meta.url);
const load = (path: string) => import(new URL(path, upstream).href);
const { catalogAppJobPrefix } = await load(
  "apps/hosted/server/src/contracts/catalog-app-updates.ts",
);
const { queueCatalogAppUpdates } = (await load(
  "apps/hosted/server/src/implementation/catalog-app-upgrades.ts",
)) as {
  queueCatalogAppUpdates: (
    feedUrl: string,
    release: string,
  ) => Effect.Effect<void, unknown, SqlClient.SqlClient>;
};

const release = "a".repeat(40);
const sweeps = `${catalogAppJobPrefix}${release}:%`;

/** One data-step tick of a fresh isolate, after this release's sweeps were already queued. */
const tick = (sql: SqlClient.SqlClient) =>
  queueCatalogAppUpdates("http://catalog.invalid/feed/index.json", release).pipe(
    Effect.provideService(SqlClient.SqlClient, sql),
  );

/** The release's marker, as the data step leaves it once the release's sweeps are queued. */
const releaseQueued = (sql: SqlClient.SqlClient) =>
  Effect.gen(function* () {
    yield* sql`create table private_hosted_data_steps (name text not null, run text not null,
      mode text not null, completed_at timestamptz, primary key (name, run))`;
    yield* sql`insert into private_hosted_data_steps values
      (${`${catalogAppJobPrefix}${release}`}, 'apply', 'apply', now())`;
  });

/** The production shape: every attempt of the organization's job fails on the compiler's memory. */
const exhaust = (scenario: { sql: SqlClient.SqlClient; execute: Effect.Effect<void, unknown> }) =>
  Effect.gen(function* () {
    for (let attempt = 1; attempt <= 8; attempt++) {
      if (attempt > 1)
        yield* scenario.sql`update hosted_provisioning set available_at = now() where id = ${job}`;
      yield* scenario.execute;
    }
  });

const jobs = (sql: SqlClient.SqlClient) =>
  sql<{ id: string; status: string; user_id: string }>`select id, status, user_id
    from hosted_provisioning where id like ${sweeps} order by updated_at, id`;

test("a sweep that ran out of build memory is queued again later and then updates the copy", async () => {
  // Two compiler calls per attempt (one retry each): the first job's eight attempts all fail,
  // and the compiler has recovered by the time the requeued sweep runs.
  await withScenario({ memoryFailures: 16 }, (scenario) =>
    Effect.gen(function* () {
      const { sql } = scenario;
      yield* releaseQueued(sql);
      yield* exhaust(scenario);
      assert.deepEqual(
        (yield* jobs(sql)).map((row) => row.status),
        ["failed"],
      );

      yield* tick(sql);
      assert.equal((yield* jobs(sql)).length, 1, "no new sweep right after the failure");

      yield* sql`update hosted_provisioning set updated_at = now() - interval '61 minutes' where id = ${job}`;
      yield* tick(sql);
      const requeued = (yield* jobs(sql)).filter((row) => row.id !== job);
      assert.equal(requeued.length, 1, "the failed sweep is queued again after its cool-down");
      assert.equal(requeued[0]!.status, "queued");
      assert.equal(requeued[0]!.user_id, "member-a", "run as the organization's owner");

      yield* tick(sql);
      assert.equal((yield* jobs(sql)).length, 2, "one queued sweep is never duplicated");

      yield* sql`update hosted_provisioning set available_at = now() where id = ${requeued[0]!.id}`;
      yield* scenario.execute;
      const [done] = yield* sql<{ status: string }>`select status from hosted_provisioning
        where id = ${requeued[0]!.id}`;
      assert.equal(done!.status, "succeeded", "the requeued job runs as a catalog sweep");
      assert.equal(scenario.state.apps.get("alpha")!.active, version2, "the copy is updated");
      assert.equal(
        (yield* scenario.record)[0]!.apps.alpha.version,
        version2,
        "and recorded as the catalog's own",
      );

      yield* sql`update hosted_provisioning set updated_at = now() - interval '1 day' where id like ${sweeps}`;
      yield* tick(sql);
      assert.equal((yield* jobs(sql)).length, 2, "a release with a succeeded sweep is done");
    }),
  );
});

test("each further failed sweep doubles the wait, until the release is replaced", async () => {
  await withScenario({ memoryFailures: 0, persistent: true }, (scenario) =>
    Effect.gen(function* () {
      const { sql } = scenario;
      yield* releaseQueued(sql);
      yield* exhaust(scenario);
      const failAll = (minutesAgo: number) =>
        sql`update hosted_provisioning set status = 'failed',
          updated_at = now() - ${`${minutesAgo} minutes`}::interval where id like ${sweeps}`;
      const count = Effect.map(jobs(sql), (rows) => rows.length);

      yield* failAll(61);
      yield* tick(sql);
      assert.equal(yield* count, 2, "one failed sweep: queued again after 1 h");

      yield* failAll(119);
      yield* tick(sql);
      assert.equal(yield* count, 2, "two failed sweeps: not before 2 h");
      yield* failAll(121);
      yield* tick(sql);
      assert.equal(yield* count, 3, "two failed sweeps: queued again after 2 h");

      yield* failAll(239);
      yield* tick(sql);
      assert.equal(yield* count, 3, "three failed sweeps: not before 4 h");
      yield* failAll(241);
      yield* tick(sql);
      assert.equal(yield* count, 4, "three failed sweeps: queued again after 4 h");

      const other = queueCatalogAppUpdates(
        "http://catalog.invalid/feed/index.json",
        "b".repeat(40),
      );
      yield* sql`insert into private_hosted_data_steps values
        (${`${catalogAppJobPrefix}${"b".repeat(40)}`}, 'apply', 'apply', now())`;
      yield* failAll(100_000);
      yield* other.pipe(Effect.provideService(SqlClient.SqlClient, sql));
      assert.equal(yield* count, 4, "a later release's ticks never queue an earlier release");

      assert.equal(scenario.state.apps.get("alpha")!.active, version1);
      assert.equal(scenario.state.apps.get("beta")!.active, version2);
    }),
  );
});

test("a sweep that succeeded, or one still queued, is not queued again", async () => {
  await withScenario({ memoryFailures: 0 }, (scenario) =>
    Effect.gen(function* () {
      const { sql } = scenario;
      yield* releaseQueued(sql);
      yield* sql`update hosted_provisioning set updated_at = now() - interval '2 hours' where id = ${job}`;
      yield* tick(sql);
      assert.equal((yield* jobs(sql)).length, 1, "a queued sweep is left alone");
      yield* scenario.execute;
      yield* sql`update hosted_provisioning set updated_at = now() - interval '2 hours' where id = ${job}`;
      yield* tick(sql);
      assert.deepEqual(
        (yield* jobs(sql)).map((row) => row.status),
        ["succeeded"],
      );
    }),
  );
});
