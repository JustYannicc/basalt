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
const { queueCatalogAppUpdates } = await load(
  "apps/hosted/server/src/implementation/catalog-app-upgrades.ts",
);

const release = "a".repeat(40);
const sweeps = `${catalogAppJobPrefix}${release}:%`;

/** One data-step tick of a fresh isolate, after this release's sweeps were already queued. */
const tick = (sql: SqlClient.SqlClient) =>
  queueCatalogAppUpdates("http://catalog.invalid/feed/index.json", release).pipe(
    Effect.provideService(SqlClient.SqlClient, sql),
  );

test("a sweep that ran out of build memory is queued again later for the same release, bounded", async () => {
  await withScenario({ memoryFailures: 0, persistent: true }, (scenario) =>
    Effect.gen(function* () {
      const { sql } = scenario;
      yield* sql`create table private_hosted_data_steps (name text not null, run text not null,
        mode text not null, completed_at timestamptz, primary key (name, run))`;
      yield* sql`insert into private_hosted_data_steps values
        (${`${catalogAppJobPrefix}${release}`}, 'apply', 'apply', now())`;
      // The production shape: eight attempts, each failing on the compiler's memory limit.
      for (let attempt = 1; attempt <= 8; attempt++) {
        if (attempt > 1)
          yield* sql`update hosted_provisioning set available_at = now() where id = ${job}`;
        yield* scenario.execute;
      }
      const jobs = () =>
        sql<{ id: string; status: string }>`select id, status from hosted_provisioning
          where id like ${sweeps} order by id`;
      assert.deepEqual(
        (yield* jobs()).map((row) => row.status),
        ["failed"],
      );

      yield* tick(sql);
      assert.equal((yield* jobs()).length, 1, "no new sweep right after the failure");

      yield* sql`update hosted_provisioning set updated_at = now() - interval '2 hours' where id = ${job}`;
      yield* tick(sql);
      const requeued = (yield* jobs()).filter((row) => row.id !== job);
      assert.equal(requeued.length, 1, "the failed sweep is queued again after its cool-down");
      assert.equal(requeued[0]!.status, "queued");
      const [owner] = yield* sql<{ organization_id: string; user_id: string }>`
        select organization_id, user_id from hosted_provisioning where id = ${requeued[0]!.id}`;
      assert.deepEqual(owner, { organization_id: "team", user_id: "member-a" });

      yield* tick(sql);
      assert.equal((yield* jobs()).length, 2, "one queued sweep is never duplicated");

      // Exhaust the bound: every sweep of this release failed, long ago.
      yield* sql`update hosted_provisioning set status = 'failed', updated_at = now() - interval '2 hours'
        where id like ${sweeps}`;
      for (let round = 0; round < 6; round++) {
        yield* tick(sql);
        yield* sql`update hosted_provisioning set status = 'failed', updated_at = now() - interval '2 hours'
          where id like ${sweeps}`;
      }
      const bounded = (yield* jobs()).length;
      yield* tick(sql);
      assert.equal((yield* jobs()).length, bounded, "requeues stop at the bound");
      assert.ok(bounded <= 4, `at most four sweeps per release and organization, saw ${bounded}`);

      assert.equal(scenario.state.apps.get("alpha")!.active, version1);
      assert.equal(scenario.state.apps.get("beta")!.active, version2);
    }),
  );
});

test("a sweep that succeeded, or one still queued, is not queued again", async () => {
  await withScenario({ memoryFailures: 0 }, (scenario) =>
    Effect.gen(function* () {
      const { sql } = scenario;
      yield* sql`create table private_hosted_data_steps (name text not null, run text not null,
        mode text not null, completed_at timestamptz, primary key (name, run))`;
      yield* sql`insert into private_hosted_data_steps values
        (${`${catalogAppJobPrefix}${release}`}, 'apply', 'apply', now())`;
      yield* sql`update hosted_provisioning set updated_at = now() - interval '2 hours' where id = ${job}`;
      yield* tick(sql);
      assert.equal(
        (yield* sql`select id from hosted_provisioning where id like ${sweeps}`).length,
        1,
        "a queued sweep is left alone",
      );
      yield* scenario.execute;
      yield* sql`update hosted_provisioning set updated_at = now() - interval '2 hours' where id = ${job}`;
      yield* tick(sql);
      const rows = yield* sql<{ status: string }>`select status from hosted_provisioning
        where id like ${sweeps}`;
      assert.deepEqual(
        rows.map((row) => row.status),
        ["succeeded"],
      );
    }),
  );
});
