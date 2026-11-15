import assert from "node:assert/strict";
import { test } from "node:test";
import type pg from "pg";
import { projectPoolHistoryChanges } from "../../src/pool/model-history/change-projection.ts";
import {
  historyJournalActivateVersion,
  historyJournalPrepareVersion,
} from "../../src/pool/model-history/change-journal-schema.ts";
import {
  activateModelHistoryJournal,
  migrateModelHistory,
} from "../../src/pool/model-history/schema.ts";
import {
  historyPool,
  localHomePostgres,
  postgresHomeChanges,
} from "./history-change-postgres-fixture.ts";

type Clients = Parameters<Parameters<typeof postgresHomeChanges>[0]>[0];
const proof = (name: string, work: (clients: Clients) => Promise<void>) =>
  test(name, { skip: !localHomePostgres, timeout: 20000 }, () =>
    postgresHomeChanges(async (clients) => {
      const version = Number(
        (await clients.a.query("show server_version_num")).rows[0].server_version_num,
      );
      assert.ok(version >= 170000 && version < 180000, "These proofs require PostgreSQL 17");
      await clients.a.query(`truncate basalt_pool_change_pending,basalt_pool_change_heads,
        basalt_pool_change_dirty,basalt_pool_change_batches`);
      await work(clients);
    }),
  );

async function state(client: pg.Client, pool = historyPool, topic = "pool-readings") {
  return (
    await client.query(
      `select basalt_pool_change_revision($1,$2)::text as logical,
    (select revision::text from basalt_pool_change_heads where pool=$1 and topic=$2) as physical,
    (select revision::text from basalt_pool_change_pending where pool=$1 and topic=$2) as pending,
    (select count(*)::int from basalt_pool_change_dirty where pool=$1 and topic=$2) as dirty,
    (select count(*)::int from basalt_pool_change_batches) as batches`,
      [pool, topic],
    )
  ).rows[0];
}

async function queue(client: pg.Client, pool = historyPool, topic = "pool-readings") {
  await client.query("select basalt_pool_change($1,$2)", [pool, topic]);
}

async function project(client: pg.Client, limit = 100) {
  return (await client.query("select basalt_pool_project_changes($1) as projected", [limit]))
    .rows[0].projected;
}

async function retained(client: pg.Client) {
  const markers = (
    await client.query(
      "select transaction_id::text as id from basalt_pool_change_batches order by transaction_id",
    )
  ).rows;
  const dirty = (
    await client.query(`select transaction_id::text as id,pool,topic
    from basalt_pool_change_dirty order by transaction_id,pool,topic`)
  ).rows;
  assert.deepEqual(
    markers.map((row) => row.id),
    [...new Set(dirty.map((row) => row.id))],
  );
  return dirty;
}

proof(
  "Home committed credential writes change the logical head with the projector stopped and compact without changing it",
  async ({ a, observer }) => {
    assert.deepEqual(await state(observer), {
      logical: "0",
      physical: null,
      pending: null,
      dirty: 0,
      batches: 0,
    });
    await a.query("begin");
    await a.query("update auth set label='First' where uuid='target-credential'");
    await a.query("update auth set label='Second' where uuid='target-credential'");
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
      (await observer.query("select label from auth where uuid='target-credential'")).rows[0].label,
      "Second",
    );
    assert.deepEqual(await state(observer), {
      logical: "1",
      physical: null,
      pending: null,
      dirty: 1,
      batches: 1,
    });
    await a.query("update auth set label='Third' where uuid='target-credential'");
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
    assert.equal(await projectPoolHistoryChanges(a), 1);
    assert.deepEqual(await state(observer), {
      logical: "2",
      physical: "2",
      pending: "2",
      dirty: 0,
      batches: 0,
    });
    assert.equal(await projectPoolHistoryChanges(a), 0);
  },
);

proof(
  "Home rollback removes the credential edit and every journal entry",
  async ({ a, observer }) => {
    await a.query("begin");
    await a.query("update auth set label='Rolled back' where uuid='target-credential'");
    await queue(a, historyPool, "pool-usage");
    assert.equal((await state(a)).logical, "1");
    assert.equal((await state(observer)).logical, "0");
    await a.query("rollback");
    assert.equal(
      (await observer.query("select label from auth where uuid='target-credential'")).rows[0].label,
      "Initial",
    );
    for (const topic of ["pool-readings", "pool-usage"])
      assert.deepEqual(await state(observer, historyPool, topic), {
        logical: "0",
        physical: null,
        pending: null,
        dirty: 0,
        batches: 0,
      });
    assert.deepEqual(await retained(observer), []);
    assert.equal(await projectPoolHistoryChanges(a), 0);
  },
);

proof(
  "Home projects a newer committed transaction before an older in-flight transaction without dropping its later commit",
  async ({ a, b, observer }) => {
    await a.query("begin");
    const older = (await a.query("select txid_current()::text as id")).rows[0].id;
    await queue(a);
    await b.query("begin");
    const newer = (await b.query("select txid_current()::text as id")).rows[0].id;
    assert.ok(BigInt(older) < BigInt(newer));
    await queue(b);
    await b.query("commit");
    assert.deepEqual(await retained(observer), [
      { id: newer, pool: historyPool, topic: "pool-readings" },
    ]);
    assert.equal((await state(observer)).logical, "1");
    assert.equal(await projectPoolHistoryChanges(observer), 1);
    assert.deepEqual(await state(observer), {
      logical: "1",
      physical: "1",
      pending: "1",
      dirty: 0,
      batches: 0,
    });
    await a.query("commit");
    assert.deepEqual(await retained(observer), [
      { id: older, pool: historyPool, topic: "pool-readings" },
    ]);
    assert.deepEqual(await state(observer), {
      logical: "2",
      physical: "1",
      pending: "1",
      dirty: 1,
      batches: 1,
    });
    assert.equal(await projectPoolHistoryChanges(observer), 1);
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
  "Home overlapping projectors claim exact batches and retain the third batch and dirty key",
  async ({ a, b, observer }) => {
    const pools = ["app_projector_1", "app_projector_2", "app_projector_3"];
    for (const pool of pools) await queue(observer, pool);
    const original = await retained(observer);
    assert.deepEqual(
      original.map((row) => row.pool),
      pools,
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
    assert.deepEqual(await state(observer, pools[2]), {
      logical: "1",
      physical: null,
      pending: null,
      dirty: 1,
      batches: 1,
    });
    assert.equal(await projectPoolHistoryChanges(observer), 1);
    assert.deepEqual(await retained(observer), []);
    assert.deepEqual(
      (
        await observer.query(
          "select pool,revision::text from basalt_pool_change_heads order by pool",
        )
      ).rows,
      pools.map((pool) => ({ pool, revision: "1" })),
    );
    assert.deepEqual(
      (
        await observer.query(
          "select pool,revision::text from basalt_pool_change_pending order by pool",
        )
      ).rows,
      pools.map((pool) => ({ pool, revision: "1" })),
    );
  },
);

proof(
  "Home projection abort restores both topics and retry publishes each revision exactly once",
  async ({ a, b, observer }) => {
    await observer.query("begin");
    await queue(observer);
    await queue(observer, historyPool, "pool-usage");
    await observer.query("commit");
    const original = await retained(observer);
    await a.query("begin");
    assert.equal(await project(a), 1);
    assert.deepEqual(await retained(a), []);
    assert.equal((await state(a)).physical, "1");
    assert.deepEqual(await retained(observer), original);
    assert.equal((await state(observer)).physical, null);
    await assert.rejects(
      a.query("select 1/0"),
      (error: unknown) => error instanceof Error && "code" in error && error.code === "22012",
    );
    await a.query("rollback");
    assert.deepEqual(await retained(observer), original);
    assert.equal(await projectPoolHistoryChanges(b), 1);
    assert.equal(await projectPoolHistoryChanges(b), 0);
    assert.deepEqual(await retained(observer), []);
    for (const topic of ["pool-readings", "pool-usage"])
      assert.deepEqual(await state(observer, historyPool, topic), {
        logical: "1",
        physical: "1",
        pending: "1",
        dirty: 0,
        batches: 0,
      });
  },
);

proof(
  "Home repeated writes coalesce per transaction and topic but a later transaction advances again",
  async ({ a, observer }) => {
    await a.query("begin");
    for (const topic of ["pool-readings", "pool-usage", "pool-readings", "pool-usage"])
      await queue(a, historyPool, topic);
    await a.query("commit");
    assert.equal((await retained(observer)).length, 2);
    for (const topic of ["pool-readings", "pool-usage"])
      assert.deepEqual(await state(observer, historyPool, topic), {
        logical: "1",
        physical: null,
        pending: null,
        dirty: 1,
        batches: 1,
      });
    assert.equal(await projectPoolHistoryChanges(a), 1);
    await queue(a, historyPool, "pool-usage");
    assert.equal((await state(observer)).logical, "1");
    assert.equal((await state(observer, historyPool, "pool-usage")).logical, "2");
    assert.equal(await projectPoolHistoryChanges(a), 1);
    assert.deepEqual(await state(observer, historyPool, "pool-usage"), {
      logical: "2",
      physical: "2",
      pending: "2",
      dirty: 0,
      batches: 0,
    });
  },
);

proof(
  "Home rejects unsupported topics and projection limits without leaving a journal batch",
  async ({ a, observer }) => {
    await assert.rejects(
      queue(a, historyPool, "accounts"),
      (error: unknown) => error instanceof Error && "code" in error && error.code === "23514",
    );
    for (const limit of [0, 101])
      await assert.rejects(
        project(a, limit),
        (error: unknown) => error instanceof Error && "code" in error && error.code === "22023",
      );
    assert.deepEqual(await retained(observer), []);
    assert.equal(
      (await observer.query("select count(*)::int as count from basalt_pool_change_batches"))
        .rows[0].count,
      0,
    );
    assert.deepEqual(await state(observer), {
      logical: "0",
      physical: null,
      pending: null,
      dirty: 0,
      batches: 0,
    });
  },
);

test(
  "Home actual migrations prepare without switching the producer and activate exact v10 despite a later marker",
  {
    skip: !localHomePostgres,
    timeout: 20000,
  },
  () =>
    postgresHomeChanges(async ({ a, observer }) => {
      const version = Number((await a.query("show server_version_num")).rows[0].server_version_num);
      assert.ok(version >= 170000 && version < 180000, "These proofs require PostgreSQL 17");
      await a.query(`create table basalt_model_history_migrations (
    name text primary key,completed_at timestamptz not null default current_timestamp)`);
      await assert.rejects(
        activateModelHistoryJournal(a),
        /Prepare the model history change journal before activation/,
      );
      assert.deepEqual(
        (await a.query("select name from basalt_model_history_migrations")).rows,
        [],
      );

      await migrateModelHistory(a);
      await migrateModelHistory(a);
      assert.deepEqual(
        (
          await a.query(
            `select name from basalt_model_history_migrations
    where name=any($1::text[]) order by name collate "C"`,
            [[historyJournalPrepareVersion, historyJournalActivateVersion]],
          )
        ).rows,
        [{ name: historyJournalPrepareVersion }],
      );
      await a.query("truncate basalt_pool_change_pending,basalt_pool_change_heads");
      await a.query("update auth set label='Prepared legacy write' where uuid='target-credential'");
      assert.deepEqual(await state(observer), {
        logical: "1",
        physical: "1",
        pending: "1",
        dirty: 0,
        batches: 0,
      });
      assert.equal(await projectPoolHistoryChanges(a), 0);

      const later = "model_request_history_v999_future";
      await a.query("insert into basalt_model_history_migrations(name) values($1)", [later]);
      await activateModelHistoryJournal(a);
      await activateModelHistoryJournal(a);
      assert.deepEqual(
        (
          await a.query(
            `select name from basalt_model_history_migrations
    where name=any($1::text[]) order by name collate "C"`,
            [[historyJournalPrepareVersion, historyJournalActivateVersion, later]],
          )
        ).rows,
        [historyJournalActivateVersion, later, historyJournalPrepareVersion]
          .sort()
          .map((name) => ({ name })),
      );
      assert.deepEqual(await state(observer), {
        logical: "1",
        physical: "1",
        pending: "1",
        dirty: 0,
        batches: 0,
      });
      await a.query("delete from basalt_pool_change_pending");
      await a.query(
        "update auth set label='Activated journal write' where uuid='target-credential'",
      );
      assert.deepEqual(await state(observer), {
        logical: "2",
        physical: "1",
        pending: null,
        dirty: 1,
        batches: 1,
      });
      assert.equal(await projectPoolHistoryChanges(a), 1);
      assert.deepEqual(await state(observer), {
        logical: "2",
        physical: "2",
        pending: "2",
        dirty: 0,
        batches: 0,
      });
    }, "legacy"),
);
