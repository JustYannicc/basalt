import assert from "node:assert/strict";
import { test } from "node:test";
import pg from "pg";
import { historyInsertFixture, insertPools } from "./history-insert-fixture.ts";
import { digest } from "../../src/pool/backend-users.ts";
import type { BulkDefinition } from "../../src/pool/model-history/bulk-contract.ts";
import { commitBulkChunk } from "../../src/pool/model-history/bulk-progress.ts";
import { insertBulkRequests } from "../../src/pool/model-history/bulk-store.ts";
import { parseBulkUsageImport } from "../../src/pool/model-history/import.ts";
import { migrateModelHistory } from "../../src/pool/model-history/schema.ts";

// Each case reproduced PostgreSQL 40P01 under a serialized-invalidation design that locked
// mappings or heads (by table or by a mapping-scoped advisory key) during the history INSERT.
// The bulk writer's only lock before the INSERT is the eligibility share lock, and its single
// pool-usage bump runs last and resolves no mappings, so both transactions must commit.
const outcome = <T>(work: Promise<T>) =>
  work.then(
    () => ({ ok: true as const }),
    (error: { code?: string }) => ({ ok: false as const, code: error.code }),
  );

async function mappedChunk() {
  const source = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
  const data = JSON.stringify({
    source_id: 1,
    event_hash: "a".repeat(64),
    timestamp: "2026-01-01T00:00:00Z",
    failed: false,
  });
  const identity = { pool: insertPools[0]!, organization: "fixture-org", owner: "fixture-owner" };
  const accountMappings = [
    {
      sourceAccountRef: "b".repeat(64),
      targetAccountId: "fixture-target",
      provider: "fixture-provider",
    },
  ];
  const parsed = await parseBulkUsageImport(
    { source, format: "cpamp-v1-jsonl", data, accountMappings },
    { pool: identity.pool, person: identity.owner },
  );
  const mapDigest = await digest(JSON.stringify(accountMappings));
  const definition: BulkDefinition = {
    job: await digest("fixture-bulk-lock-cycle"),
    identity,
    manifestDigest: await digest("fixture-manifest"),
    accountMappingDigest: mapDigest,
    accountMappings,
    manifest: {
      version: 1,
      source,
      sourceHash: await digest(data),
      approvedManifestSha256: await digest("fixture-approved"),
      accountMappingDigest: mapDigest,
      totalRows: 1,
      chunks: [
        {
          sha256: await digest(data),
          idsSha256: await digest(JSON.stringify(parsed.records.map((row) => row.id))),
          rows: 1,
          bytes: Buffer.byteLength(data),
        },
      ],
    },
  };
  return { definition, data };
}

for (const mapping of ["a table lock", "an advisory lock"] as const) {
  test(
    `bulk eligibility and a mapping UPDATE holding ${mapping} both commit`,
    { timeout: 20_000 },
    async () => {
      await historyInsertFixture(async ({ a, b, reader }) => {
        await migrateModelHistory(a);
        await a.query(`CREATE TABLE auth(id text PRIMARY KEY,provider text,disabled boolean,
        deleted_at timestamptz);
        INSERT INTO auth VALUES('fixture-target','fixture-provider',false,NULL);
        INSERT INTO channel_group_detail VALUES(1,1,'fixture-target',NULL)`);
        await b.query("RESET ROLE; SET deadlock_timeout='30ms'; SET ROLE basalt_pool_owner");
        const { definition, data } = await mappedChunk();
        const schema = (await a.query("SELECT current_schema() AS name")).rows[0]!.name;
        const url = new URL(process.env.POOL_TEST_ADMIN_URL!);
        url.searchParams.set("options", `-c search_path=${schema} -c deadlock_timeout=30ms`);
        let entered!: (pid: number) => void, release!: () => void;
        const eligible = new Promise<number>((resolve) => (entered = resolve));
        const resume = new Promise<void>((resolve) => (release = resolve));
        // Hold the bulk writer between its FOR SHARE eligibility read and the history INSERT.
        const original = pg.Client.prototype.query;
        Reflect.set(
          pg.Client.prototype,
          "query",
          async function (this: pg.Client, ...args: never[]) {
            const result = await Reflect.apply(original, this, args);
            if (String(args[0]).includes("FOR SHARE OF a,d,g")) {
              const { rows } = await Reflect.apply(original, this, [
                "SELECT pg_backend_pid() AS pid",
              ]);
              entered(Number(rows[0].pid));
              await resume;
            }
            return result;
          },
        );
        let history: Promise<{ ok: boolean; code?: string }> | undefined;
        let update: Promise<{ ok: boolean; code?: string }> | undefined;
        try {
          history = outcome(commitBulkChunk(url.href, definition, 0, data));
          const writer = await Promise.race([
            eligible,
            history.then((result) => {
              throw new Error(`bulk writer ended before eligibility: ${JSON.stringify(result)}`);
            }),
          ]);
          const waiter = (await b.query("SELECT pg_backend_pid() AS pid")).rows[0]!.pid;
          await b.query("BEGIN");
          await b.query(
            mapping === "a table lock"
              ? "LOCK TABLE channel_group IN ROW EXCLUSIVE MODE"
              : "SELECT pg_advisory_xact_lock(hashtextextended('fixture-mapping',0))",
          );
          update = outcome(b.query("UPDATE channel_group SET disabled=true WHERE id=1")).then(
            async (result) => {
              await b.query(result.ok ? "COMMIT" : "ROLLBACK");
              return result;
            },
          );
          // Release only once the mapping writer waits on the bulk writer's share lock.
          const deadline = performance.now() + 10_000;
          let settled = false;
          void update.then(
            () => (settled = true),
            () => (settled = true),
          );
          for (let blocked = false; !blocked;) {
            assert.ok(
              performance.now() < deadline,
              "mapping UPDATE never waited on the bulk writer",
            );
            if (settled)
              assert.fail(`mapping UPDATE never waited: ${JSON.stringify(await update)}`);
            blocked = (
              await reader.query("SELECT $2::int = ANY(pg_blocking_pids($1::int)) AS blocked", [
                waiter,
                writer,
              ])
            ).rows[0]!.blocked;
          }
          release();
          assert.deepEqual(await Promise.all([history, update]), [{ ok: true }, { ok: true }]);
        } finally {
          release();
          Reflect.set(pg.Client.prototype, "query", original);
          await b.query("ROLLBACK").catch(() => {});
          await history;
          await update;
        }
        assert.equal(
          (await a.query("SELECT count(*)::int AS n FROM basalt_model_requests")).rows[0]!.n,
          1,
        );
      });
    },
  );
}

test("two bulk writers under the prepared journal commit without upgrading head locks", async () => {
  await historyInsertFixture(async ({ a, b, reader, rows }) => {
    await migrateModelHistory(a);
    for (const client of [a, b])
      await client.query("RESET ROLE; SET deadlock_timeout='30ms'; SET ROLE basalt_pool_owner");
    await reader.query("SELECT pg_advisory_lock(66011901),pg_advisory_lock(66011902)");
    const incoming = await rows([insertPools[0]!, insertPools[1]!]);
    // Park each writer after its row is written and before its scope bump.
    await a.query(`CREATE FUNCTION fixture_pause_two() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      IF NEW.id='${incoming[0]!.id}' THEN RAISE NOTICE 'fixture_gate_a';
        PERFORM pg_advisory_xact_lock(66011901);
      ELSE RAISE NOTICE 'fixture_gate_b'; PERFORM pg_advisory_xact_lock(66011902); END IF;
      RETURN NULL; END $$;
      CREATE TRIGGER zz_fixture_pause AFTER INSERT ON basalt_model_requests FOR EACH ROW
        EXECUTE FUNCTION fixture_pause_two()`);
    let enteredA!: () => void, enteredB!: () => void;
    const gateA = new Promise<void>((resolve) => (enteredA = resolve));
    const gateB = new Promise<void>((resolve) => (enteredB = resolve));
    a.on("notice", (notice) => notice.message === "fixture_gate_a" && enteredA());
    b.on("notice", (notice) => notice.message === "fixture_gate_b" && enteredB());
    const write = async (client: pg.Client, pool: string, record: (typeof incoming)[number]) => {
      await client.query("BEGIN");
      await insertBulkRequests(client, [record], pool);
      await client.query("COMMIT");
    };
    const one = outcome(write(a, insertPools[0]!, incoming[0]!));
    const two = outcome(write(b, insertPools[1]!, incoming[1]!));
    try {
      await Promise.race([
        Promise.all([gateA, gateB]),
        Promise.all([one, two]).then((results) => {
          throw new Error(`writers ended before their gates: ${JSON.stringify(results)}`);
        }),
      ]);
      await reader.query("SELECT pg_advisory_unlock(66011901),pg_advisory_unlock(66011902)");
      assert.deepEqual(await Promise.all([one, two]), [{ ok: true }, { ok: true }]);
    } finally {
      await reader.query("SELECT pg_advisory_unlock_all()");
      await one;
      await two;
    }
  }, false);
});
