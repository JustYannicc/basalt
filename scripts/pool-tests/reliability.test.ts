import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { PGlite } from "../../.upstream/node_modules/@electric-sql/pglite/dist/index.js";
import { digest } from "../../src/pool/backend-users.ts";
import {
  historySchemaVersion,
  historyTerminalIntegrityVersion,
  migrateModelHistory,
  type HistoryDatabase,
} from "../../src/pool/model-history/schema.ts";
import { recordGatewayRefusal } from "../../src/pool/model-history/gateway.ts";
import { modelHistorySchemaPlan } from "../../src/pool/model-history/operator.ts";
import {
  readPoolReliability,
  terminalCollectionReady,
} from "../../src/pool/model-history/reliability.ts";
import { reference, timestamp } from "../../src/pool/model-history/record.ts";
import { historyMemoryOwnerFixture } from "./history-fixture.ts";
import { readPoolReliabilitySlo } from "../../src/pool/model-history/reliability-slo.ts";
import { handleTrafficOperation } from "../../src/pool/model-history/traffic.ts";
import {
  recordTerminalFinish,
  recordTerminalStart,
} from "../../src/pool/model-history/terminal.ts";

async function insertHomeAttempt(
  db: HistoryDatabase,
  input: {
    requestId: string;
    keyId: number;
    at: string;
    failed: boolean;
    status: number;
    attempt?: number;
  },
) {
  const source = await digest("home-local-v1");
  const sourceRecord = await digest(
    JSON.stringify(["usage", `${input.requestId}:${input.attempt ?? 1}`]),
  );
  const pool = (await digest("fixture")).slice(0, 16);
  const person = await digest("fixture-person");
  const clientKey = await reference(source, "key", input.keyId);
  await db.query(
    `INSERT INTO basalt_model_requests
      (id,source,source_record,timestamp,timestamp_exact,pool,person,client_key,request_id,
        token_quality,failed,status_code,cost_basis,attribution)
    VALUES ($1,$2,$3,$4::timestamptz,$5,$6,$7,$8,$9,'unclassified',$10,$11,'unpriced','unknown')`,
    [
      await digest(JSON.stringify([source, sourceRecord])),
      source,
      sourceRecord,
      timestamp(input.at),
      timestamp(input.at),
      pool,
      person,
      clientKey,
      input.requestId,
      input.failed,
      input.status,
    ],
  );
}

async function insertTerminal(
  db: HistoryDatabase,
  requestId: string,
  keyId: number,
  outcome: "complete" | "truncated" | "client_closed" | "provider_failed" | "unavailable",
  status: number,
  at: string,
) {
  await recordTerminalStart(db, {
    requestId,
    pool: "fixture",
    person: await digest("fixture-person"),
    keyId,
    pathname: "/v1/chat/completions",
    at,
  });
  await recordTerminalFinish(db, requestId, { outcome, status, bytes: 123, at });
}

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

test("terminal evidence overlays one Home attempt and replaces its fallback without rewriting raw usage", async () => {
  await fixture(async (db) => {
    await db.query("INSERT INTO usage VALUES (1),(2)");
    const usageBefore = (await db.query("SELECT id FROM usage ORDER BY id")).rows;
    const first = randomUUID();
    await insertHomeAttempt(db, {
      requestId: first,
      keyId: 11,
      at: "2026-11-12T02:10:00Z",
      failed: false,
      status: 200,
    });
    await insertTerminal(db, first, 11, "truncated", 200, "2026-11-12T02:10:00Z");
    await recordTerminalStart(db, {
      requestId: first,
      pool: "fixture",
      person: await digest("fixture-person"),
      keyId: 11,
      pathname: "/v1/chat/completions",
      at: "2026-11-12T02:11:00Z",
    });
    await recordTerminalFinish(db, first, {
      outcome: "complete",
      status: 200,
      bytes: 123,
      at: "2026-11-12T02:11:00Z",
    });

    const window = { from: "2026-11-12T02:00:00Z", to: "2026-11-12T03:00:00Z" };
    let result = await readPoolReliability(db, "fixture", window.from, window.to);
    assert.equal(result.real.requests, 1);
    assert.equal(result.real.failed, 1, "HTTP 200 truncation is still one failed request");
    assert.deepEqual(result.real.failures, [{ status: 200, count: 1, unassigned: 1 }]);
    assert.deepEqual(
      (
        await db.query("SELECT failed,status_code FROM basalt_model_requests WHERE request_id=$1", [
          first,
        ])
      ).rows,
      [{ failed: false, status_code: 200 }],
      "delivery evidence does not rewrite the append-only Home row",
    );

    const fallback = randomUUID();
    await insertTerminal(db, fallback, 12, "client_closed", 200, "2026-11-12T02:20:00Z");
    result = await readPoolReliability(db, "fixture", window.from, window.to);
    assert.equal(result.real.requests, 2);
    assert.equal(result.real.failed, 2);
    await insertHomeAttempt(db, {
      requestId: fallback,
      keyId: 12,
      at: "2026-11-12T02:20:00Z",
      failed: false,
      status: 200,
    });
    result = await readPoolReliability(db, "fixture", window.from, window.to);
    assert.equal(
      result.real.requests,
      2,
      "a later Home row replaces, rather than duplicates, fallback",
    );
    assert.equal(result.real.failed, 2);

    const homeFailure = randomUUID();
    await insertHomeAttempt(db, {
      requestId: homeFailure,
      keyId: 13,
      at: "2026-11-12T02:30:00Z",
      failed: true,
      status: 500,
    });
    await insertTerminal(db, homeFailure, 13, "complete", 200, "2026-11-12T02:30:00Z");
    const complete = randomUUID();
    await insertHomeAttempt(db, {
      requestId: complete,
      keyId: 14,
      at: "2026-11-12T02:40:00Z",
      failed: false,
      status: 200,
    });
    await insertTerminal(db, complete, 14, "complete", 200, "2026-11-12T02:40:00Z");

    const retried = randomUUID();
    await insertHomeAttempt(db, {
      requestId: retried,
      keyId: 16,
      at: "2026-11-12T02:44:00Z",
      failed: false,
      status: 200,
      attempt: 1,
    });
    await insertHomeAttempt(db, {
      requestId: retried,
      keyId: 16,
      at: "2026-11-12T02:45:00Z",
      failed: false,
      status: 200,
      attempt: 2,
    });
    await insertTerminal(db, retried, 16, "truncated", 200, "2026-11-12T02:45:00Z");

    const longStream = randomUUID();
    await recordTerminalStart(db, {
      requestId: longStream,
      pool: "fixture",
      person: await digest("fixture-person"),
      keyId: 17,
      pathname: "/v1/chat/completions",
      at: "2026-11-12T02:40:00Z",
    });
    await recordTerminalFinish(db, longStream, {
      outcome: "truncated",
      status: 200,
      bytes: 123,
      at: "2026-11-12T02:59:00Z",
    });
    let current = await readPoolReliability(
      db,
      "fixture",
      "2026-11-12T02:54:00Z",
      "2026-11-12T03:00:00Z",
    );
    assert.equal(current.real.requests, 1, "terminal-only failure appears by its finish time");
    assert.equal(current.real.failed, 1);
    await insertHomeAttempt(db, {
      requestId: longStream,
      keyId: 17,
      at: "2026-11-12T02:40:00Z",
      failed: false,
      status: 200,
    });
    current = await readPoolReliability(
      db,
      "fixture",
      "2026-11-12T02:54:00Z",
      "2026-11-12T03:00:00Z",
    );
    assert.equal(current.real.requests, 1, "Home ingest retains the same finish-time counter");
    assert.equal(current.real.failed, 1);

    const source = await digest("home-local-v1");
    const pool = (await digest("fixture")).slice(0, 16);
    const proofKey = (await reference(source, "key", 15))!;
    await db.query(
      `INSERT INTO basalt_model_traffic (pool,source,client_key,purpose,evidence)
        VALUES ($1,$2,$3,'proof',$4)`,
      [pool, source, proofKey, "e".repeat(64)],
    );
    const proofRequest = randomUUID();
    await insertHomeAttempt(db, {
      requestId: proofRequest,
      keyId: 15,
      at: "2026-11-12T02:50:00Z",
      failed: false,
      status: 200,
    });
    await insertTerminal(db, proofRequest, 15, "provider_failed", 200, "2026-11-12T02:50:00Z");

    result = await readPoolReliability(db, "fixture", window.from, window.to);
    assert.equal(result.real.requests, 7);
    assert.equal(result.real.failed, 5, "only the last Home attempt receives the delivery failure");
    assert.ok(
      result.real.failures.some((failure) => failure.status === 500 && failure.count === 1),
    );
    assert.equal(result.proof.requests, 1, "Home's client_key proof classification is preserved");
    assert.equal(result.proof.failed, 1);
    assert.deepEqual((await db.query("SELECT id FROM usage ORDER BY id")).rows, usageBefore);
    assert.equal(
      (await db.query("SELECT count(*)::text AS count FROM basalt_model_terminal_starts")).rows[0]!
        .count,
      "7",
      "repeated start and finish calls are idempotent",
    );
    assert.equal(
      (await db.query("SELECT count(*)::text AS count FROM basalt_model_terminal_finishes"))
        .rows[0]!.count,
      "7",
    );
    await assert.rejects(db.query("UPDATE basalt_model_terminal_finishes SET outcome='complete'"), {
      code: "55000",
    });
  });
});

test("an existing v4 database keeps history counts but cannot claim terminal reliability", async () => {
  await fixture(async (db) => {
    const now = Date.parse("2026-11-12T03:00:00Z");
    const source = await digest("home-local-v1");
    await db.query(
      `INSERT INTO basalt_model_history_cursor
      (source,forward_id,backfill_upper,backfill_id,backfill_complete,sweep_id,updated_at)
      VALUES ($1,0,0,0,true,0,$2)`,
      [source, new Date(now).toISOString()],
    );
    await insertHomeAttempt(db, {
      requestId: randomUUID(),
      keyId: 21,
      at: "2026-11-12T02:30:00Z",
      failed: false,
      status: 200,
    });
    await db.query("DROP TABLE basalt_model_terminal_finishes");
    await db.query("DROP TABLE basalt_model_terminal_starts");
    await db.query("DELETE FROM basalt_model_history_migrations WHERE name=$1", [
      historyTerminalIntegrityVersion,
    ]);

    const result = await readPoolReliabilitySlo(db, "fixture", now);
    assert.equal(result.state, "unavailable");
    assert.equal(result.reason, "terminal_collection_unavailable");
    assert.equal(result.hour.real.requests, 1, "historical Home counts remain readable");
  });
});

test("unavailable terminal outcomes do not create fallback traffic and make the SLO unavailable", async () => {
  await fixture(async (db) => {
    const now = Date.parse("2026-11-12T03:00:00Z");
    const source = await digest("home-local-v1");
    await db.query(
      `INSERT INTO basalt_model_history_cursor
      (source,forward_id,backfill_upper,backfill_id,backfill_complete,sweep_id,updated_at)
      VALUES ($1,0,0,0,true,0,$2)`,
      [source, new Date(now).toISOString()],
    );
    await db.query("UPDATE basalt_model_history_migrations SET completed_at=$2 WHERE name=$1", [
      historyTerminalIntegrityVersion,
      new Date(now - 3_600_000).toISOString(),
    ]);
    await insertTerminal(db, randomUUID(), 22, "unavailable", 200, "2026-11-12T02:50:00Z");
    const count = await readPoolReliability(
      db,
      "fixture",
      "2026-11-12T02:00:00Z",
      "2026-11-12T03:00:00Z",
    );
    assert.equal(count.real.requests, 0, "unavailable evidence is not a fallback denominator");
    const result = await readPoolReliabilitySlo(db, "fixture", now);
    assert.equal(result.state, "unavailable");
    assert.equal(result.reason, "terminal_collection_unavailable");
  });
});

test("future-dated unavailable finishes do not extend the 24-hour SLO gap", async () => {
  await fixture(async (db) => {
    const now = Date.parse("2026-11-12T03:00:00Z");
    const source = await digest("home-local-v1");
    await db.query(
      `INSERT INTO basalt_model_history_cursor
      (source,forward_id,backfill_upper,backfill_id,backfill_complete,sweep_id,updated_at)
      VALUES ($1,0,0,0,true,0,$2)`,
      [source, new Date(now).toISOString()],
    );
    await db.query("UPDATE basalt_model_history_migrations SET completed_at=$2 WHERE name=$1", [
      historyTerminalIntegrityVersion,
      new Date(now - 3_600_000).toISOString(),
    ]);
    await insertTerminal(
      db,
      randomUUID(),
      22,
      "unavailable",
      200,
      new Date(now + 60_000).toISOString(),
    );

    const result = await readPoolReliabilitySlo(db, "fixture", now);
    assert.equal(result.state, "no_traffic");
    assert.equal(result.reason, undefined);
  });
});

test("post-v7 Home usage without a matching terminal receipt blocks SLO reliance", async () => {
  await fixture(async (db) => {
    const now = Date.parse("2026-11-12T03:00:00Z");
    const source = await digest("home-local-v1");
    await db.query(
      `INSERT INTO basalt_model_history_cursor
      (source,forward_id,backfill_upper,backfill_id,backfill_complete,sweep_id,updated_at)
      VALUES ($1,0,0,0,true,0,$2)`,
      [source, new Date(now).toISOString()],
    );
    await db.query("UPDATE basalt_model_history_migrations SET completed_at=$2 WHERE name=$1", [
      historyTerminalIntegrityVersion,
      new Date(now - 3_600_000).toISOString(),
    ]);
    await insertHomeAttempt(db, {
      requestId: randomUUID(),
      keyId: 23,
      at: "2026-11-12T02:55:00Z",
      failed: false,
      status: 200,
    });
    const result = await readPoolReliabilitySlo(db, "fixture", now);
    assert.equal(result.state, "unavailable");
    assert.equal(result.reason, "terminal_collection_unavailable");
    assert.equal(result.hour.real.requests, 1);
    assert.equal(result.current?.real.requests, 1);
  });
});

test("a terminal start pending for ten minutes makes the SLO explicitly pending", async () => {
  await fixture(async (db) => {
    const now = Date.parse("2026-11-12T03:00:00Z");
    const source = await digest("home-local-v1");
    await db.query(
      `INSERT INTO basalt_model_history_cursor
      (source,forward_id,backfill_upper,backfill_id,backfill_complete,sweep_id,updated_at)
      VALUES ($1,0,0,0,true,0,$2)`,
      [source, new Date(now).toISOString()],
    );
    await recordTerminalStart(db, {
      requestId: randomUUID(),
      pool: "fixture",
      person: await digest("fixture-person"),
      keyId: 24,
      pathname: "/v1/chat/completions",
      at: new Date(now - 10 * 60_000 - 1).toISOString(),
    });
    const result = await readPoolReliabilitySlo(db, "fixture", now);
    assert.equal(result.state, "unavailable");
    assert.equal(result.reason, "terminal_collection_pending");
  });
});

test("the history operator exposes v7 as a self-creating additive step from v4", async () => {
  await fixture(async (db) => {
    await db.query("ALTER TABLE usage ADD COLUMN timestamp timestamptz");
    await db.query(
      "CREATE TABLE home_data_migration (name text PRIMARY KEY,completed boolean NOT NULL)",
    );
    await db.query(
      "INSERT INTO home_data_migration VALUES ('diagnostics_metadata_only_v1_1_6',true)",
    );
    const current = await modelHistorySchemaPlan(db);
    assert.equal(current.version, historySchemaVersion);
    assert.equal(current.applied, true);
    assert.deepEqual(current.catalogDiff.createTables, []);
    assert.deepEqual(current.catalogDiff.addIndexes, []);

    await db.query("DROP TABLE basalt_model_terminal_finishes");
    await db.query("DROP TABLE basalt_model_terminal_starts");
    await db.query("DROP INDEX basalt_model_requests_pool_source_request_exact");
    await db.query("DELETE FROM basalt_model_history_migrations WHERE name=$1", [
      historyTerminalIntegrityVersion,
    ]);
    const upgrade = await modelHistorySchemaPlan(db);
    assert.equal(upgrade.applied, false);
    assert.deepEqual(upgrade.pendingMigrations, [historyTerminalIntegrityVersion]);
    assert.deepEqual(upgrade.catalogDiff.createTables, [
      "basalt_model_terminal_finishes",
      "basalt_model_terminal_starts",
    ]);
    assert.deepEqual(upgrade.catalogDiff.addIndexes, [
      "basalt_model_requests_pool_source_request_exact",
      "basalt_model_terminal_starts_pool_time",
      "basalt_model_terminal_finishes_time",
    ]);

    await migrateModelHistory(db);
    const applied = await modelHistorySchemaPlan(db);
    assert.equal(applied.applied, true);
    assert.deepEqual(applied.pendingMigrations, []);
    assert.deepEqual(applied.catalogDiff.createTables, []);
  });
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

test("terminal collection readiness stays bound to v7 while v8 completion is independent", async () => {
  await fixture(async (db) => {
    await db.query("DELETE FROM basalt_model_history_migrations WHERE name=$1", [
      historySchemaVersion,
    ]);
    assert.equal(await terminalCollectionReady(db), true);
    await db.query("INSERT INTO basalt_model_history_migrations (name) VALUES ($1)", [
      historySchemaVersion,
    ]);
    await db.query("DELETE FROM basalt_model_history_migrations WHERE name=$1", [
      historyTerminalIntegrityVersion,
    ]);
    assert.equal(await terminalCollectionReady(db), false);
  });
});
