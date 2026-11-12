import assert from "node:assert/strict";
import { test } from "node:test";
import { PGlite } from "../../.upstream/node_modules/@electric-sql/pglite/dist/index.js";
import { digest } from "../../src/pool/backend-users.ts";
import { migrateModelHistory, type HistoryDatabase } from "../../src/pool/model-history/schema.ts";
import { recordGatewayRefusal } from "../../src/pool/model-history/gateway.ts";
import { readPoolReliability } from "../../src/pool/model-history/reliability.ts";
import { reference } from "../../src/pool/model-history/record.ts";
import { historyMemoryOwnerFixture } from "./history-fixture.ts";
import { readPoolReliabilitySlo } from "../../src/pool/model-history/reliability-slo.ts";
import { handleTrafficOperation } from "../../src/pool/model-history/traffic.ts";

async function fixture(work: (db: HistoryDatabase) => Promise<void>) {
  const database = new PGlite();
  const db: HistoryDatabase = {
    query: async (text, values) => {
      const result = await database.query<Record<string, unknown>>(text, values);
      return { rows: result.rows, rowCount: result.affectedRows ?? result.rows.length };
    },
  };
  try {
    await historyMemoryOwnerFixture(db);
    await migrateModelHistory(db);
    await db.query("CREATE TABLE usage (id bigint PRIMARY KEY)");
    await work(db);
  } finally {
    await database.close();
  }
}

test("proof failures stay visible separately while unknown traffic counts toward real reliability", async () => {
  const database = new PGlite();
  const db: HistoryDatabase = {
    query: async (text, values) => {
      const result = await database.query<Record<string, unknown>>(text, values);
      return { rows: result.rows, rowCount: result.affectedRows ?? result.rows.length };
    },
  };
  try {
    await historyMemoryOwnerFixture(db);
    await migrateModelHistory(db);
    await db.query(
      `INSERT INTO basalt_model_history_cursor
      (source,forward_id,backfill_upper,backfill_id,backfill_complete,sweep_id)
      VALUES ($1,0,0,0,true,0)`,
      [await digest("home-local-v1")],
    );
    for (const keyId of [1, 2])
      await recordGatewayRefusal(db, {
        requestId: crypto.randomUUID(),
        at: "2026-11-12T02:10:00Z",
        pool: "fixture",
        person: await digest("fixture-person"),
        keyId,
        pathname: "/v1/messages",
        latencyMs: 5,
      });
    const source = await digest("pool-gateway-v1");
    await db.query(
      "INSERT INTO basalt_model_traffic (pool,source,client_key,purpose,evidence) VALUES ($1,$2,$3,'proof',$4)",
      [
        (await digest("fixture")).slice(0, 16),
        source,
        await reference(source, "key", 1),
        "a".repeat(64),
      ],
    );
    const result = await readPoolReliability(
      db,
      "fixture",
      "2026-11-12T02:00:00Z",
      "2026-11-12T03:00:00Z",
    );
    assert.equal(result.real.requests, 1);
    assert.equal(result.real.failed, 1);
    assert.equal(result.real.unassignedFailures, 1);
    assert.equal(result.proof.requests, 1);
    assert.equal(result.proof.failed, 1);
    assert.equal(result.classification, "ready");
    assert.deepEqual(result.real.failures, [{ status: 503, count: 1, unassigned: 1 }]);
    const empty = await readPoolReliability(
      db,
      "fixture",
      "2026-11-12T03:00:00Z",
      "2026-11-12T04:00:00Z",
    );
    assert.equal(empty.real.successRate, null);
    assert.equal(
      (await db.query("SELECT count(*)::text AS count FROM basalt_model_requests")).rows[0]!.count,
      "2",
    );
  } finally {
    await database.close();
  }
});

test("the 1h and 24h SLO uses exact real counts, detects stale capture and never treats no traffic as 100%", async () => {
  await fixture(async (db) => {
    const now = Date.parse("2026-11-12T03:00:00Z");
    const source = await digest("home-local-v1"),
      pool = (await digest("fixture")).slice(0, 16);
    await db.query(
      `INSERT INTO basalt_model_history_cursor
      (source,forward_id,backfill_upper,backfill_id,backfill_complete,sweep_id,updated_at)
      VALUES ($1,0,0,0,true,0,$2)`,
      [source, new Date(now).toISOString()],
    );
    const empty = await readPoolReliabilitySlo(db, "fixture", now);
    assert.equal(empty.state, "no_traffic");
    assert.equal(empty.hour.real.successRate, null);
    await db.query(
      `INSERT INTO basalt_model_requests
      (id,source,source_record,timestamp,timestamp_exact,pool,client_key,token_quality,failed,status_code,cost_basis,attribution)
      SELECT lpad(n::text,64,'0'),$1,lpad(n::text,64,'0'),'2026-11-12T02:30:00Z',
        '2026-11-12T02:30:00.000000000Z',$2,$3,'unclassified',n=1,CASE WHEN n=1 THEN 500 ELSE 200 END,'unpriced','unknown'
      FROM generate_series(1,100) n`,
      [source, pool, "a".repeat(64)],
    );
    const exactly = await readPoolReliabilitySlo(db, "fixture", now);
    assert.equal(exactly.state, "ok");
    assert.equal(exactly.hour.real.successRate, 99);
    await db.query(
      `INSERT INTO basalt_model_requests
      (id,source,source_record,timestamp,timestamp_exact,pool,client_key,token_quality,failed,status_code,cost_basis,attribution)
      VALUES ($1,$2,$1,'2026-11-12T02:31:00Z','2026-11-12T02:31:00.000000000Z',$3,$4,'unclassified',true,503,'unpriced','unknown')`,
      ["b".repeat(64), source, pool, "b".repeat(64)],
    );
    const breached = await readPoolReliabilitySlo(db, "fixture", now);
    assert.equal(breached.state, "breached");
    assert.equal(breached.hour.real.requests, 101);
    assert.equal(breached.day.real.failed, 2);
    await db.query(
      "INSERT INTO basalt_model_traffic (pool,source,client_key,purpose,evidence) VALUES ($1,$2,$3,'proof',$4)",
      [pool, source, "b".repeat(64), "e".repeat(64)],
    );
    const separated = await readPoolReliabilitySlo(db, "fixture", now);
    assert.equal(separated.state, "ok");
    assert.equal(separated.hour.real.requests, 100);
    assert.equal(separated.hour.proof.failed, 1);
    await db.query("INSERT INTO usage VALUES (1)");
    const lagging = await readPoolReliabilitySlo(db, "fixture", now);
    assert.equal(lagging.state, "unavailable");
    assert.equal(lagging.reason, "capture_lagging");
    await db.query("UPDATE basalt_model_history_cursor SET forward_id=1");
    assert.equal((await readPoolReliabilitySlo(db, "fixture", now)).state, "ok");
    const stale = await readPoolReliabilitySlo(db, "fixture", now + 600_001);
    assert.equal(stale.state, "unavailable");
    assert.equal(stale.reason, "capture_stale");
    await db.query("DROP TABLE basalt_model_traffic");
    const pending = await readPoolReliabilitySlo(db, "fixture", now);
    assert.equal(pending.state, "unavailable");
    assert.equal(pending.reason, "classification_pending");
    assert.equal(pending.day.real.failed, 2, "without an explicit marker the request remains real");
  });
});

test("private traffic tagging defaults to a dry run, binds the exact selection and can restore a key to real", async () => {
  await fixture(async (db) => {
    const source = await digest("home-local-v1");
    const selection = {
      pool: "fixture",
      purpose: "proof",
      evidence: "e".repeat(64),
      keys: [{ source, clientKey: "a".repeat(64) }],
    };
    const request = (body: unknown) =>
      new Request("http://fixture/model-history/traffic", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
    const preview = await (await handleTrafficOperation(request({ selection }), db)).json();
    assert.equal(preview.status, "dry-run");
    assert.equal(preview.writes, false);
    assert.equal((await db.query("SELECT * FROM basalt_model_traffic")).rows.length, 0);
    const changed = await handleTrafficOperation(
      request({ selection: { ...selection, purpose: "real" }, go: true, digest: preview.digest }),
      db,
    );
    assert.equal(changed.status, 409);
    assert.equal((await db.query("SELECT * FROM basalt_model_traffic")).rows.length, 0);
    assert.equal(
      (await handleTrafficOperation(request({ selection, go: true, digest: preview.digest }), db))
        .status,
      200,
    );
    assert.equal(
      (await db.query("SELECT purpose FROM basalt_model_traffic")).rows[0]!.purpose,
      "proof",
    );
    const undo = { ...selection, purpose: "real" };
    const undoPlan = await (await handleTrafficOperation(request({ selection: undo }), db)).json();
    assert.equal(
      (
        await handleTrafficOperation(
          request({ selection: undo, go: true, digest: undoPlan.digest }),
          db,
        )
      ).status,
      200,
    );
    assert.equal(
      (await db.query("SELECT purpose FROM basalt_model_traffic")).rows[0]!.purpose,
      "real",
    );
  });
});
