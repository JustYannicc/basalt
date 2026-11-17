import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { PGlite } from "../../.upstream/node_modules/@electric-sql/pglite/dist/index.js";
import { backendUserName, digest } from "../../src/pool/backend-users.ts";
import { runAvailabilityProbe } from "../../src/pool/availability-schedule.ts";
import { captureHomeRequests } from "../../src/pool/model-history/capture.ts";
import { readPoolReliabilitySlo } from "../../src/pool/model-history/reliability-slo.ts";
import { reference } from "../../src/pool/model-history/record.ts";
import { migrateModelHistory, type HistoryDatabase } from "../../src/pool/model-history/schema.ts";
import {
  recordTerminalFinish,
  recordTerminalStart,
} from "../../src/pool/model-history/terminal.ts";
import { reportingCadence } from "../../src/pool/reporting.ts";
import { historyMemoryOwnerFixture, homeMetadataFixture } from "./history-fixture.ts";

for (const revoked of [false, true])
  test(`a new proof key's completed first stream waits for capture without paging, revoked=${revoked}`, async (t) => {
    const captured = Date.parse("2026-11-16T06:00:00Z");
    t.mock.timers.enable({ apis: ["Date"], now: captured });
    const database = new PGlite();
    const db: HistoryDatabase = {
      query: async (text, values) => {
        const result = await database.query<Record<string, unknown>>(text, values);
        return { rows: result.rows, rowCount: result.affectedRows ?? result.rows.length };
      },
    };
    const messages: Record<string, unknown>[] = [];
    const diagnostics: unknown[][] = [];
    t.mock.method(globalThis, "fetch", async (_input: unknown, init: RequestInit) => {
      messages.push(JSON.parse(new TextDecoder().decode(init.body as ArrayBuffer).split("\n")[2]!));
      return new Response(null, { status: 202 });
    });
    t.mock.method(console, "warn", (...args: unknown[]) => diagnostics.push(args));
    try {
      await historyMemoryOwnerFixture(db);
      await homeMetadataFixture(db);
      await migrateModelHistory(db);
      const source = await digest("home-local-v1");
      await db.query(
        `INSERT INTO basalt_model_history_cursor
          (source,forward_id,backfill_upper,backfill_id,backfill_complete,sweep_id,updated_at)
        VALUES ($1,0,0,0,true,0,$2)`,
        [source, new Date(captured).toISOString()],
      );
      await db.query("UPDATE basalt_model_history_migrations SET completed_at=$1", [
        new Date(captured - 3_600_000).toISOString(),
      ]);
      assert.equal((await readPoolReliabilitySlo(db, "fixture", captured)).state, "no_traffic");

      const keyId = 41;
      const fingerprint = `sha256:${"a".repeat(64)}`;
      await db.query('INSERT INTO "user" (id,username) VALUES (1,$1)', [
        await backendUserName("fixture-person", "fixture"),
      ]);
      await db.query("INSERT INTO api_key (id,user_id,diagnostic_fingerprint) VALUES ($1,1,$2)", [
        keyId,
        fingerprint,
      ]);
      await db.query(
        `INSERT INTO basalt_model_traffic (pool,source,client_key,purpose,evidence)
        VALUES ($1,$2,$3,'proof',$4)`,
        [
          (await digest("fixture")).slice(0, 16),
          source,
          await reference(source, "key", keyId),
          "e".repeat(64),
        ],
      );
      const requestId = randomUUID();
      const started = new Date(captured + 60_000).toISOString();
      const finished = new Date(captured + 65_000).toISOString();
      await recordTerminalStart(db, {
        requestId,
        pool: "fixture",
        person: await digest("fixture-person"),
        keyId,
        at: started,
        pathname: "/v1/chat/completions",
      });
      await db.query("INSERT INTO usage (id,timestamp,request_id,api_key) VALUES (1,$1,$2,$3)", [
        started,
        requestId,
        fingerprint,
      ]);
      await db.query("INSERT INTO billing_charge (usage_id,api_key_id,user_id) VALUES (1,$1,1)", [
        keyId,
      ]);
      await recordTerminalFinish(db, requestId, {
        outcome: "complete",
        status: 200,
        bytes: 123,
        at: finished,
      });
      if (revoked) await db.query("DELETE FROM api_key WHERE id=$1", [keyId]);

      async function monitor(at: number) {
        t.mock.timers.setTime(at);
        const measured = await readPoolReliabilitySlo(db, "fixture", at);
        messages.length = 0;
        diagnostics.length = 0;
        await runAvailabilityProbe(
          {
            POOL_AVAILABILITY_TARGET: "fixture",
            SENTRY_DSN: "https://fixture_public_key@o123.ingest.de.sentry.io/456",
          },
          async () => ({ ok: true, failures: [] }),
          async () => measured,
        );
        return measured;
      }

      const beforeCapture = await monitor(captured + 120_000);
      assert.equal(beforeCapture.state, "unavailable");
      assert.equal(beforeCapture.reason, "capture_lagging");
      assert.equal(
        beforeCapture.hour.proof.requests,
        1,
        "terminal evidence already covers the new stream",
      );
      assert.equal(beforeCapture.hour.real.requests, 0);
      assert.equal(
        messages.filter((message) => message.fingerprint).length,
        0,
        "a completed proof stream awaiting its scheduled capture must not page collection failure",
      );
      assert.equal((diagnostics[0]![1] as { reason: string }).reason, "capture_lagging");

      const overdue = await monitor(captured + reportingCadence + 1);
      assert.equal(overdue.reason, "capture_lagging");
      assert.deepEqual(
        messages.filter((message) => message.fingerprint).map((message) => message.fingerprint),
        [["basalt", "pool_request_reliability_unavailable"]],
        "an overdue capture must still page",
      );

      const result = await captureHomeRequests(db);
      assert.equal(result.state, "active");
      assert.equal(result.inserted, 1);
      // The database clock is independent of Node's mocked monitor clock.
      await db.query("UPDATE basalt_model_history_cursor SET updated_at=$1 WHERE source=$2", [
        new Date(captured + reportingCadence + 1).toISOString(),
        source,
      ]);
      const afterCapture = await monitor(captured + reportingCadence + 2);
      assert.equal(afterCapture.state, "no_traffic");
      assert.equal(afterCapture.reason, undefined);
      assert.equal(
        afterCapture.hour.proof.requests,
        1,
        "capture replaces terminal fallback without double counting",
      );
      assert.equal(
        afterCapture.hour.real.requests,
        0,
        "revocation preserves charged proof attribution",
      );
      assert.equal(messages.filter((message) => message.fingerprint).length, 0);
    } finally {
      await database.close();
    }
  });
