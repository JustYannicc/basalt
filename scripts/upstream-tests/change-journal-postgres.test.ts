import assert from "node:assert/strict";
import { test } from "node:test";
import type pg from "pg";
import { code, localPostgres, owner, postgresChanges } from "./account-change-postgres-fixture.ts";

type Clients = Parameters<Parameters<typeof postgresChanges>[0]>[0];
const proof = (name: string, work: (clients: Clients) => Promise<void>) =>
  test(name, { skip: !localPostgres, timeout: 20000 }, () =>
    postgresChanges(async (clients) => {
      const version = Number(
        (await clients.a.query("show server_version_num")).rows[0].server_version_num,
      );
      assert.ok(version >= 170000 && version < 180000, "These proofs require PostgreSQL 17");
      await clients.a.query(`truncate hosted_change_pending,hosted_change_heads,
        hosted_change_dirty,hosted_change_batches`);
      await work(clients);
    }, "activate"),
  );

async function state(client: pg.Client, topic = "accounts", resource = "*") {
  return (
    await client.query(
      `select hosted_change_revision($1,$2,$3)::text as logical,
    (select revision::text from hosted_change_heads where scope=$1 and topic=$2 and resource=$3) as physical,
    (select revision::text from hosted_change_pending where scope=$1 and topic=$2 and resource=$3) as pending,
    (select count(*)::int from hosted_change_dirty where scope=$1 and topic=$2 and resource=$3) as dirty,
    (select count(*)::int from hosted_change_batches) as batches`,
      [owner, topic, resource],
    )
  ).rows[0];
}

async function queue(
  client: pg.Client,
  resource = "*",
  revision: number | null = null,
  topic = "accounts",
) {
  await client.query("select hosted_queue_change($1,$2,$3,$4::bigint)", [
    owner,
    topic,
    resource,
    revision,
  ]);
}

async function project(client: pg.Client, limit = 100) {
  return (await client.query("select hosted_project_changes($1) as projected", [limit])).rows[0]
    .projected;
}

async function retained(client: pg.Client) {
  const markers = (
    await client.query(
      "select transaction_id::text as id from hosted_change_batches order by transaction_id",
    )
  ).rows;
  const dirty = (
    await client.query(`select transaction_id::text as id,resource
    from hosted_change_dirty order by transaction_id,resource`)
  ).rows;
  assert.deepEqual(
    markers.map((row) => row.id),
    [...new Set(dirty.map((row) => row.id))],
  );
  return dirty;
}

proof(
  "Hosted committed account writes change the logical head with the projector stopped and compact without changing it",
  async ({ a, observer }) => {
    assert.deepEqual(await state(observer), {
      logical: "0",
      physical: null,
      pending: null,
      dirty: 0,
      batches: 0,
    });
    await a.query("begin");
    await a.query("update executor_accounts set label='First' where id='acc_a'");
    await a.query("update executor_accounts set label='Second' where id='acc_a'");
    assert.deepEqual(await state(observer), {
      logical: "0",
      physical: null,
      pending: null,
      dirty: 0,
      batches: 0,
    });
    assert.deepEqual(await state(a), {
      logical: "1",
      physical: null,
      pending: null,
      dirty: 1,
      batches: 1,
    });
    await a.query("commit");
    assert.equal(
      (await observer.query("select label from executor_accounts where id='acc_a'")).rows[0].label,
      "Second",
    );
    assert.deepEqual(await state(observer), {
      logical: "1",
      physical: null,
      pending: null,
      dirty: 1,
      batches: 1,
    });
    await a.query("update executor_accounts set label='Third' where id='acc_a'");
    assert.deepEqual(await state(observer), {
      logical: "2",
      physical: null,
      pending: null,
      dirty: 2,
      batches: 2,
    });
    assert.equal(await project(a, 1), 1);
    assert.deepEqual(await state(observer), {
      logical: "2",
      physical: "1",
      pending: "1",
      dirty: 1,
      batches: 1,
    });
    assert.equal(await project(a), 1);
    assert.deepEqual(await state(observer), {
      logical: "2",
      physical: "2",
      pending: "2",
      dirty: 0,
      batches: 0,
    });
    assert.equal(await project(a), 0);
  },
);

proof(
  "Hosted rolls back domain changes, dirty keys and their batch marker together",
  async ({ a, observer }) => {
    await a.query("begin");
    await a.query("update executor_accounts set label='Rolled back' where id='acc_a'");
    assert.equal((await state(a)).logical, "1");
    assert.equal((await state(observer)).logical, "0");
    await a.query("rollback");
    assert.equal(
      (await observer.query("select label from executor_accounts where id='acc_a'")).rows[0].label,
      "Retained",
    );
    assert.deepEqual(await state(observer), {
      logical: "0",
      physical: null,
      pending: null,
      dirty: 0,
      batches: 0,
    });
    assert.equal(
      (await observer.query("select count(*)::int as count from hosted_change_dirty")).rows[0]
        .count,
      0,
    );
    assert.equal(await project(a), 0);
  },
);

proof(
  "Hosted projects a higher transaction id first without losing an older transaction that commits later",
  async ({ a, b, observer }) => {
    await a.query("begin");
    const older = (await a.query("select txid_current()::text as id")).rows[0].id;
    await queue(a);
    await b.query("begin");
    const newer = (await b.query("select txid_current()::text as id")).rows[0].id;
    assert.ok(BigInt(older) < BigInt(newer));
    await queue(b);
    await b.query("commit");
    assert.deepEqual(await retained(observer), [{ id: newer, resource: "*" }]);
    assert.equal((await state(observer)).logical, "1");
    assert.equal(await project(observer), 1);
    assert.deepEqual(await state(observer), {
      logical: "1",
      physical: "1",
      pending: "1",
      dirty: 0,
      batches: 0,
    });
    await a.query("commit");
    assert.deepEqual(await retained(observer), [{ id: older, resource: "*" }]);
    assert.deepEqual(await state(observer), {
      logical: "2",
      physical: "1",
      pending: "1",
      dirty: 1,
      batches: 1,
    });
    assert.equal(await project(observer), 1);
    assert.deepEqual(await state(observer), {
      logical: "2",
      physical: "2",
      pending: "2",
      dirty: 0,
      batches: 0,
    });
  },
);

proof(
  "Hosted overlapping projectors claim exact batches and preserve the unclaimed marker and dirty key",
  async ({ a, b, observer }) => {
    for (const resource of ["first", "second", "third"]) await queue(observer, resource);
    const original = await retained(observer);
    assert.deepEqual(
      original.map((row) => row.resource),
      ["first", "second", "third"],
    );
    await a.query("begin isolation level read committed");
    assert.equal(await project(a, 1), 1);
    await b.query("begin isolation level read committed");
    assert.equal(await project(b, 1), 1);
    assert.deepEqual(await retained(a), original.slice(1));
    assert.deepEqual(await retained(b), [original[0], original[2]]);
    assert.deepEqual(await retained(observer), original);
    await b.query("commit");
    assert.deepEqual(await retained(observer), [original[0], original[2]]);
    await a.query("commit");
    assert.deepEqual(await retained(observer), [original[2]]);
    assert.equal((await state(observer, "accounts", "third")).physical, null);
    assert.equal((await state(observer, "accounts", "third")).logical, "1");
    assert.equal(await project(observer), 1);
    assert.deepEqual(await retained(observer), []);
    assert.deepEqual(
      (
        await observer.query(
          "select resource,revision::text from hosted_change_heads order by resource",
        )
      ).rows,
      ["first", "second", "third"].map((resource) => ({ resource, revision: "1" })),
    );
    assert.deepEqual(
      (
        await observer.query(
          "select resource,revision::text from hosted_change_pending order by resource",
        )
      ).rows,
      ["first", "second", "third"].map((resource) => ({ resource, revision: "1" })),
    );
  },
);

proof(
  "Hosted abort after projection restores the whole batch and retry increments each key once",
  async ({ a, b, observer }) => {
    await observer.query("begin");
    await queue(observer, "first");
    await queue(observer, "second");
    await observer.query("commit");
    const original = await retained(observer);
    await a.query("begin");
    assert.equal(await project(a), 1);
    assert.deepEqual(await retained(a), []);
    assert.equal((await state(a, "accounts", "first")).physical, "1");
    assert.deepEqual(await retained(observer), original);
    assert.equal((await state(observer, "accounts", "first")).physical, null);
    await assert.rejects(a.query("select 1/0"), (error) => code(error) === "22012");
    await a.query("rollback");
    assert.deepEqual(await retained(observer), original);
    assert.equal(await project(b), 1);
    assert.equal(await project(b), 0);
    assert.deepEqual(await retained(observer), []);
    for (const resource of ["first", "second"])
      assert.deepEqual(await state(observer, "accounts", resource), {
        logical: "1",
        physical: "1",
        pending: "1",
        dirty: 0,
        batches: 0,
      });
  },
);

proof(
  "Hosted explicit pool revisions coalesce by maximum and stale or duplicate batches do not republish",
  async ({ a, observer }) => {
    await a.query("begin");
    for (const revision of [8, 3, 8]) await queue(a, "app_a", revision, "pool-readings");
    await a.query("commit");
    assert.deepEqual(await state(observer, "pool-readings", "app_a"), {
      logical: "8",
      physical: null,
      pending: null,
      dirty: 1,
      batches: 1,
    });
    assert.equal(await project(a), 1);
    await a.query("delete from hosted_change_pending");
    for (const revision of [8, 3]) await queue(a, "app_a", revision, "pool-readings");
    assert.equal(await project(a), 2);
    assert.deepEqual(await state(observer, "pool-readings", "app_a"), {
      logical: "8",
      physical: "8",
      pending: null,
      dirty: 0,
      batches: 0,
    });
    await a.query("begin");
    for (const revision of [10, 15, 13]) await queue(a, "app_a", revision, "pool-readings");
    await a.query("commit");
    assert.equal((await state(observer, "pool-readings", "app_a")).logical, "15");
    assert.equal(await project(a), 1);
    assert.deepEqual(await state(observer, "pool-readings", "app_a"), {
      logical: "15",
      physical: "15",
      pending: "15",
      dirty: 0,
      batches: 0,
    });
  },
);

proof(
  "Hosted rejects mismatched implicit and explicit topic modes without leaving batch markers",
  async ({ a, observer }) => {
    await assert.rejects(queue(a, "*", 2, "accounts"), (error) => code(error) === "23514");
    for (const topic of ["pool-readings", "pool-usage", "pool-samples", "pool-prices"])
      await assert.rejects(queue(a, "app_a", null, topic), (error) => code(error) === "23514");
    await assert.rejects(queue(a, "app_a", 0, "pool-readings"), (error) => code(error) === "23514");
    assert.deepEqual(await retained(observer), []);
    assert.equal(
      (await observer.query("select count(*)::int as count from hosted_change_batches")).rows[0]
        .count,
      0,
    );
    for (const limit of [0, 101])
      await assert.rejects(project(a, limit), (error) => code(error) === "22023");
  },
);

proof(
  "A delayed legacy head read after activation is read-only and the current journal delivery invalidates it",
  async ({ a, observer }) => {
    const { createRequire } = await import("node:module");
    const { Effect, Redacted } = await import("effect");
    const { SqlClient } = await import("effect/sql");
    const { makeChangeJournal } =
      await import("../../.upstream/apps/hosted/server/src/implementation/change-revisions.ts");
    const { makeRevisionFence } = await import("../../.upstream/packages/apps/src/client.ts");
    const require = createRequire(
      new URL("../../.upstream/packages/fumadb-effect/package.json", import.meta.url),
    );
    const PgClient: typeof import("../../.upstream/packages/fumadb-effect/node_modules/@effect/sql-pg/dist/PgClient.js") =
      await import(require.resolve("@effect/sql-pg/PgClient"));
    const schema = String(
      (await observer.query("select current_schema() as schema")).rows[0].schema,
    );
    const key = { topic: "accounts", resource: "*" };
    await a.query("update executor_accounts set label='Before delayed read' where id='acc_a'");
    assert.equal(await project(a), 1);
    await a.query("delete from hosted_change_pending");
    const delayedLegacyRead = () =>
      observer.query(
        `select topic,resource,revision::text from hosted_change_heads
        where scope=$1 and topic=$2 and resource=$3`,
        [owner, key.topic, key.resource],
      );

    await a.query(
      "update executor_accounts set label='Committed after activation' where id='acc_a'",
    );
    const domain = (
      await observer.query(
        "select row_to_json(account) as row from executor_accounts account where id='acc_a'",
      )
    ).rows[0].row;
    await observer.query("begin read only");
    const legacy = (await delayedLegacyRead()).rows;
    await observer.query("commit");
    assert.deepEqual(legacy, [{ ...key, revision: "1" }]);
    assert.deepEqual(await state(observer), {
      logical: "2",
      physical: "1",
      pending: null,
      dirty: 1,
      batches: 1,
    });
    const fence = makeRevisionFence(owner, [key]);
    const connection = fence.begin();
    assert.equal(fence.handshake(connection, legacy), true);
    assert.equal(fence.accept(connection, legacy), true);

    await Effect.runPromise(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const journal = makeChangeJournal(sql);
        const current = yield* journal.current(owner, [key]);
        assert.deepEqual(current, [{ ...key, revision: "2" }]);
        const sent: (typeof current)[number][] = [];
        yield* journal.deliver((scope, hint) =>
          Effect.gen(function* () {
            assert.equal(scope, owner);
            if (hint.topic !== key.topic || hint.resource !== key.resource) return;
            assert.deepEqual(yield* Effect.promise(() => state(observer)), {
              logical: "2",
              physical: "2",
              pending: "2",
              dirty: 0,
              batches: 0,
            });
            fence.observe(hint);
            sent.push(hint);
          }),
        );
        assert.deepEqual(sent, current);
        assert.equal(fence.accept(connection, legacy), false);
        assert.equal(fence.accept(connection, yield* journal.current(owner, [key])), true);
      }).pipe(
        Effect.provide(
          PgClient.layer({
            url: Redacted.make(process.env.POOL_TEST_ADMIN_URL!),
            maxConnections: 1,
            startupParameters: { search_path: schema },
          }),
        ),
      ),
    );
    assert.deepEqual(await state(observer), {
      logical: "2",
      physical: "2",
      pending: null,
      dirty: 0,
      batches: 0,
    });
    assert.deepEqual(
      (
        await observer.query(
          "select row_to_json(account) as row from executor_accounts account where id='acc_a'",
        )
      ).rows[0].row,
      domain,
    );
  },
);
