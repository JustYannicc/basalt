import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { PGlite } from "../../.upstream/node_modules/@electric-sql/pglite/dist/index.js";
import { backendUserName, digest } from "../../src/pool/backend-users.ts";
import { activateHomeBackfill, planHomeBackfill } from "../../src/pool/model-history/activation.ts";
import { readCaptureLag } from "../../src/pool/model-history/capture-lag.ts";
import { runModelHistoryPass, type ModelHistoryPass } from "../../src/pool/model-history/pass.ts";
import {
  activateModelHistoryJournal,
  migrateModelHistory,
  type HistoryDatabase,
} from "../../src/pool/model-history/schema.ts";
import type { ReportingProgress } from "../../src/pool/reporting.ts";
import {
  historyMemoryOwnerFixture,
  historySchemaFixture,
  homeMetadataFixture,
} from "./history-fixture.ts";

/** Capture's test fixture: two pools on Home, history activated, on real Postgres or PGlite. */
export const admin = process.env.POOL_TEST_ADMIN_URL;
if (admin && !["127.0.0.1", "localhost"].includes(new URL(admin).hostname))
  throw new Error("POOL_TEST_ADMIN_URL must point to isolated local test Postgres");
export const pools = ["app_capture_a", "app_capture_b"] as const;
const fingerprint = (key: number) => `sha256:${String(key).padStart(64, "0")}`;

export interface Fixture {
  db: HistoryDatabase;
  /** A second session on the same database, for concurrent writers; real Postgres only. */
  second?: HistoryDatabase;
}

export async function fixture(work: (f: Fixture) => Promise<void>) {
  const schema = `capture_throughput_${randomUUID().replaceAll("-", "")}`;
  const clients = admin
    ? [new pg.Client({ connectionString: admin }), new pg.Client({ connectionString: admin })]
    : [];
  const memory = admin ? null : new PGlite();
  const db: HistoryDatabase = clients[0] ?? {
    query: async (text, values) => {
      const result = await memory!.query<Record<string, unknown>>(text, values);
      return { rows: result.rows, rowCount: result.affectedRows ?? result.rows.length };
    },
  };
  try {
    if (clients.length) {
      for (const client of clients) await client.connect();
      await historySchemaFixture(db, schema);
      for (const client of clients) {
        await client.query(`SET search_path TO ${schema}`);
        await client.query("SET ROLE basalt_pool_owner");
      }
    } else await historyMemoryOwnerFixture(db);
    await homeMetadataFixture(db);
    await migrateModelHistory(db);
    await activateModelHistoryJournal(db);
    for (const [index, pool] of pools.entries()) {
      await db.query('INSERT INTO "user" VALUES($1,$2)', [
        index + 1,
        await backendUserName("person", pool),
      ]);
      await db.query("INSERT INTO api_key VALUES($1,$2,$1,NULL)", [
        index + 1,
        fingerprint(index + 1),
      ]);
    }
    await activateHomeBackfill(db, await planHomeBackfill(db));
    await work({ db, ...(clients[1] ? { second: clients[1] } : {}) });
  } finally {
    if (clients.length) {
      await db.query("ROLLBACK").catch(() => {});
      await db.query("RESET ROLE");
      await db.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      for (const client of clients) await client.end();
    } else await memory!.close();
  }
}

/** Home usage rows `count` past the last, alternating between the two pools' keys, started now. */
export async function addHome(db: HistoryDatabase, count: number) {
  await db.query(
    `INSERT INTO usage(id,timestamp,request_id,api_key)
    SELECT n,now(),'attempt-' || n,'sha256:' || lpad(((n % 2) + 1)::text,64,'0')
    FROM generate_series((SELECT COALESCE(max(id),0) + 1 FROM usage),
      (SELECT COALESCE(max(id),0) + $1::int FROM usage)) n`,
    [count],
  );
}

export const head = async (db: HistoryDatabase) =>
  String((await db.query("SELECT COALESCE(max(id),0)::text AS id FROM usage")).rows[0]!.id);
export const cursor = async (db: HistoryDatabase) =>
  String(
    (await db.query("SELECT forward_id::text AS id FROM basalt_model_history_cursor")).rows[0]!.id,
  );
export const captured = async (db: HistoryDatabase) =>
  Number(
    (await db.query("SELECT count(DISTINCT id)::int AS n FROM basalt_model_requests")).rows[0]!.n,
  );

/** Statements through `db`, with `before` run first: it may throw to cut the session there. */
export function watched(db: HistoryDatabase, before: (sql: string) => void): HistoryDatabase {
  return {
    query: async (text, values) => {
      before(text);
      return db.query(text, values);
    },
  };
}
export const pageWrite = (sql: string) => sql.includes("INSERT INTO basalt_model_requests");

/** A retained request with Home row `row`'s id, as another writer could have saved it. */
export async function saveRetained(
  db: HistoryDatabase,
  change: { source?: string; record?: string; pool?: string },
  row = 1,
) {
  const source = await digest("home-local-v1");
  const record = await digest(JSON.stringify(["usage", String(row)]));
  await db.query(
    `INSERT INTO basalt_model_requests
      (id,source,source_record,timestamp,timestamp_exact,pool,token_quality,failed,cost_basis,attribution)
    VALUES ($1,$2,$3,now(),'2026-11-25T12:00:00.000000000Z',$4,'unclassified',false,'unpriced','unknown')`,
    [
      await digest(JSON.stringify([source, record])),
      change.source ?? source,
      change.record ?? record,
      change.pool ?? "f".repeat(16),
    ],
  );
}

/**
 * The pass on the round-trip model: each statement costs one round trip of `rttMs` on the clock
 * the pass reads, on top of what the local database itself took. 100 ms is above the controller's
 * round trip inferred from production.
 */
export function onRoundTrips(
  db: HistoryDatabase,
  rttMs = 100,
  steps: Partial<Pick<ModelHistoryPass, "reliability" | "stopped">> = {},
) {
  let clock = 0;
  const timed: HistoryDatabase = {
    query: async (text, values) => {
      const started = performance.now();
      try {
        return await db.query(text, values);
      } finally {
        clock += rttMs + (performance.now() - started);
      }
    },
  };
  return (progress: ReportingProgress) =>
    runModelHistoryPass(
      {
        session: (work) => work(timed),
        publish: async () => {},
        rollup: async () => {},
        hours: async () => {},
        stopped: () => false,
        now: () => clock,
        ...steps,
      },
      progress,
    );
}

/** Rounded above one person's measured peaks: five minutes' arrivals, one pass each. */
export const steady = 2_000;
export const burst = 5_000;

export async function passes(db: HistoryDatabase, arrivals: readonly number[]) {
  const pass = onRoundTrips(db);
  for (const [index, count] of arrivals.entries()) {
    await addHome(db, count);
    const progress: ReportingProgress = { rows: null };
    await pass(progress);
    assert.notEqual(progress.outcome, "partial", `pass ${index} ended behind`);
    assert.equal(await cursor(db), await head(db), `pass ${index} left rows past the cursor`);
  }
  for (const pool of pools)
    assert.equal(
      (await readCaptureLag(db, pool, await cursor(db), new Date().toISOString())).pending,
      0,
    );
}
