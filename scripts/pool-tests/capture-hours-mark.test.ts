import assert from "node:assert/strict";
import { test } from "node:test";
import { callerHeader } from "../../apps/pool/contract.ts";
import { digest } from "../../src/pool/backend-users.ts";
import { insertBulkRequests } from "../../src/pool/model-history/bulk-store.ts";
import { captureHomeRequests } from "../../src/pool/model-history/capture.ts";
import { captureHoursTick } from "../../src/pool/model-history/capture-hours-auto.ts";
import { countBlockStatement } from "../../src/pool/model-history/capture-hours-count.ts";
import { handleUsageImport } from "../../src/pool/model-history/import-http.ts";
import { timestamp } from "../../src/pool/model-history/record.ts";
import type { HistoryDatabase } from "../../src/pool/model-history/schema.ts";
import { insertRequests } from "../../src/pool/model-history/store.ts";
import { signPoolToken } from "../../src/pool/token.ts";
import {
  at,
  captureFixture,
  clockAt,
  hourKey,
  hourMs,
  lookbackHours,
  memoryStorage,
} from "./capture-hours-fixture.ts";
import { pool, seriesFixture } from "./series-fixture.ts";

type Fixture = Parameters<Parameters<typeof seriesFixture>[0]>[0];
type Storage = ReturnType<typeof memoryStorage>;
const minute = 60_000;

/** When `pool`'s settled count of the hour holding `time` was taken, or null while it is pending. */
async function checked(f: Fixture, pool: string, time: string) {
  const hour = new Date(Math.floor(Date.parse(time) / hourMs) * hourMs).toISOString();
  const row = (
    await f.db.query(
      `SELECT checked_at FROM basalt_model_capture_hours
      WHERE pool=$1 AND hour=$2 AND checked_at >= hour + interval '2 hours'`,
      [pool, hour],
    )
  ).rows[0];
  return row ? (row.checked_at as Date).getTime() : null;
}

/**
 * Both pools counted over the fixture's lookback by ticks on the fixture's storage, which keeps
 * Home's mapping; Home's capture cursor at its head with nothing left to sweep or backfill. The
 * database clock stands half an hour into the current hour, so no hour settles while a test runs.
 * `home` adds Home rows before the counts are taken.
 */
async function counted(
  f: Fixture,
  home?: (c: Awaited<ReturnType<typeof captureFixture>>) => Promise<void>,
) {
  await clockAt(f, Math.floor(Date.now() / hourMs) * hourMs + 30 * minute);
  const c = await captureFixture(f);
  await c.native(at(2, minute));
  await c.native(at(2, minute), true);
  await home?.(c);
  await c.ready();
  await c.fill();
  const head = Number(
    (await f.db.query("SELECT coalesce(max(id),0)::int AS id FROM usage")).rows[0]!.id,
  );
  await c.cursor(head);
  await f.db.query("UPDATE basalt_model_history_cursor SET sweep_id=$1, sweep_upper=0", [head]);
  return c;
}

/** How many counts are stored. */
const stored = async (f: Fixture) =>
  Number(
    (await f.db.query("SELECT count(*)::int AS n FROM basalt_model_capture_hours")).rows[0]!.n,
  );

/** Ticks until nothing is pending, recording the blocks they count, each as its pool and range. */
async function settle(f: Fixture, storage: Storage) {
  const counts: { pool: string; from: number; to: number }[] = [];
  const db: HistoryDatabase = {
    query: (text, values) => {
      if (text === countBlockStatement)
        counts.push({
          pool: String(values![0]),
          from: Date.parse(String(values![1])),
          to: Date.parse(String(values![2])),
        });
      return f.db.query(text, values);
    },
  };
  for (let tick = 0; tick < 20; tick++) {
    const state = await captureHoursTick(storage, (work) => work(db), {
      bounds: { lookbackHours, hourMs: Number.POSITIVE_INFINITY },
    });
    if (
      state.lastStop === "complete" &&
      state.pendingHours === 0 &&
      Object.keys(state.recount ?? {}).length === 0
    )
      return { state, counts };
  }
  throw new Error("the ticks did not settle");
}

/** The one block counted, which must hold `time` and be `pool`'s. */
function onlyBlockOf(
  counts: { pool: string; from: number; to: number }[],
  pool: string,
  time: string,
) {
  assert.equal(counts.length, 1, "one block counted");
  const [block] = counts;
  assert.equal(block!.pool, pool);
  assert.ok(block!.from <= Date.parse(time) && Date.parse(time) < block!.to, "the written hour's");
}

test("a late Home row capture takes into a settled hour makes that hour, and no other, count again on the next pass", async () => {
  await seriesFixture(async (f) => {
    const c = await counted(f);
    const storage = c.storage;
    assert.deepEqual((await settle(f, storage)).counts, [], "idle: nothing to count");
    const before = await checked(f, c.poolId, at(2));
    // Home writes a row of an old hour late; capture's forward page takes it.
    await c.usage(at(2, 30 * minute));
    const captured = await captureHomeRequests(f.db);
    assert.ok(captured.state === "active");
    assert.equal(captured.inserted, 1);
    assert.equal(await checked(f, c.poolId, at(2)), null, "the write made its hour pending");
    onlyBlockOf((await settle(f, storage)).counts, c.poolId, at(2));
    assert.ok((await checked(f, c.poolId, at(2)))! > before!);
    // Counted again with its row captured, the hour is complete without a row check.
    const coverage = await c.coverage(at(2), at(3));
    assert.deepEqual([...coverage.incomplete!], []);
    assert.equal(coverage.ranges, undefined);
  });
});

test("the late-commit sweep makes the hour it fills count again", async () => {
  await seriesFixture(async (f) => {
    const c = await counted(f);
    const storage = c.storage;
    await settle(f, storage);
    // A row that committed below the forward cursor after it passed: only the sweep reaches it.
    await f.db.query("INSERT INTO usage (id,timestamp,api_key) VALUES (500,$1,$2)", [
      at(3, 10 * minute),
      c.fingerprint,
    ]);
    await f.db.query("UPDATE basalt_model_history_cursor SET sweep_id=0");
    const swept = await captureHomeRequests(f.db);
    assert.ok(swept.state === "active");
    assert.equal(swept.fresh, 0);
    assert.equal(swept.inserted, 1);
    assert.equal(await checked(f, c.poolId, at(3)), null, "the sweep made its hour pending");
    assert.notEqual(await checked(f, c.poolId, at(2)), null, "an untouched hour keeps its count");
    onlyBlockOf((await settle(f, storage)).counts, c.poolId, at(3));
  });
});

test("the backfill makes the hour it fills count again", async () => {
  await seriesFixture(async (f) => {
    const c = await counted(f);
    const storage = c.storage;
    await settle(f, storage);
    // A row only an unfinished backfill reaches.
    await f.db.query("INSERT INTO usage (id,timestamp,api_key) VALUES (600,$1,$2)", [
      at(4, 10 * minute),
      c.fingerprint,
    ]);
    await f.db.query(
      "UPDATE basalt_model_history_cursor SET backfill_complete=false, backfill_id=599, backfill_upper=600",
    );
    const backfilled = await captureHomeRequests(f.db);
    assert.ok(backfilled.state === "active");
    assert.equal(backfilled.swept, 0);
    assert.equal(backfilled.inserted, 1);
    assert.equal(await checked(f, c.poolId, at(4)), null, "the backfill made its hour pending");
    onlyBlockOf((await settle(f, storage)).counts, c.poolId, at(4));
  });
});

/** Applies an import through the endpoint, as the pool's owner: its dry run, then its approval. */
async function importer(f: Fixture) {
  const url = new URL(process.env.POOL_TEST_ADMIN_URL!);
  url.searchParams.set("options", `-c search_path=${f.schema},pg_catalog`);
  const signingKey = "ab".repeat(32),
    owner = "fixture-owner";
  const token = await signPoolToken(signingKey, {
    pool,
    owner,
    organization: "fixture-organization",
  });
  const access = {
    signingKey,
    connectionString: url.toString(),
    permissions: async () => ({ canUse: true, canManage: true }),
  };
  const request = (body: object) =>
    new Request("https://pool.example.test/pool/v1/usage/import", {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        [callerHeader]: owner,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    });
  return async (body: Record<string, unknown>) => {
    const dry = await handleUsageImport(request(body), access);
    assert.equal(dry.status, 200, await dry.clone().text());
    const { approval } = (await dry.json()) as { approval: string };
    const applied = await handleUsageImport(request({ ...body, mode: "apply", approval }), access);
    assert.equal(applied.status, 200, await applied.clone().text());
    return ((await applied.json()) as { inserted: number }).inserted;
  };
}

const exported = (source: string, usageId: number, time: string) => ({
  source,
  format: "home-v8-jsonl",
  data: JSON.stringify({
    usage_id: usageId,
    request_id: null,
    timestamp: time,
    provider: "fixture-provider",
    model: "fixture-model",
    failed: false,
    status_code: 200,
    input_tokens: 100,
    output_tokens: 10,
    cached_tokens: 20,
    cache_creation_tokens: 0,
    reasoning_tokens: 3,
    total_tokens: 110,
    latency_ms: 25,
    endpoint: "/v1/responses",
    amount: null,
  }),
});

test("a local Home import into a settled hour makes it count again", async () => {
  await seriesFixture(async (f) => {
    const c = await counted(f);
    const storage = c.storage;
    await settle(f, storage);
    // A Home row of an old hour that capture never took, imported from Home's own export.
    const usageId = await c.usage(at(5, 20 * minute));
    await c.cursor(usageId);
    const apply = await importer(f);
    assert.equal(await apply(exported("home-local-v1", usageId, at(5, 20 * minute))), 1);
    assert.equal(await checked(f, c.poolId, at(5)), null);
    onlyBlockOf((await settle(f, storage)).counts, c.poolId, at(5));
  });
});

test("an import of another source leaves every count standing: none of its rows are Home's", async () => {
  await seriesFixture(async (f) => {
    const c = await counted(f);
    const storage = c.storage;
    await settle(f, storage);
    const before = await checked(f, c.poolId, at(6));
    const apply = await importer(f);
    const source = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
    assert.equal(await apply(exported(source, 9_001, at(6, 20 * minute))), 1);
    assert.equal(await checked(f, c.poolId, at(6)), before);
    assert.deepEqual((await settle(f, storage)).counts, []);
  });
});

test("the writes behind the self-import, the gateway's refusals and the bulk loader mark Home's rows, and only those", async () => {
  await seriesFixture(async (f) => {
    const c = await counted(f);
    const home = await digest("home-local-v1");
    const other = await digest("fixture-self-import-source");
    const settledAt = (hours: number) => timestamp(at(hours, 10 * minute));
    const homeRow = async (hours: number, usage: string) =>
      f.row({
        source: home,
        sourceRecord: await digest(JSON.stringify(["usage", usage])),
        timestamp: settledAt(hours),
        pool: c.poolId,
      });
    // The self-import and the gateway write through insertRequests, with sources of their own.
    await insertRequests(f.db, [
      await f.row({ source: other, timestamp: settledAt(7), pool: c.poolId }),
    ]);
    assert.notEqual(await checked(f, c.poolId, at(7)), null, "another source marks nothing");
    await insertRequests(f.db, [await homeRow(8, "7001")]);
    assert.equal(await checked(f, c.poolId, at(8)), null, "Home's row marks its hour");
    // The bulk loader writes through insertBulkRequests, in its caller's transaction.
    await f.db.query("BEGIN");
    await insertBulkRequests(f.db, [
      await f.row({ source: other, timestamp: settledAt(9), pool: c.poolId }),
      await homeRow(10, "7002"),
    ]);
    await f.db.query("COMMIT");
    assert.notEqual(await checked(f, c.poolId, at(9)), null);
    assert.equal(await checked(f, c.poolId, at(10)), null);
    // Counted again, a row written a second time changes nothing, so it marks nothing.
    await settle(f, c.storage);
    const held = await homeRow(10, "7002");
    await insertRequests(f.db, [held]);
    await f.db.query("BEGIN");
    await insertBulkRequests(f.db, [held]);
    await f.db.query("COMMIT");
    assert.notEqual(await checked(f, c.poolId, at(10)), null);
  });
});

test("Home remapping a pool's keys or users makes the pools involved count again, the case the timed recount was for", async () => {
  for (const [label, change, involved] of [
    [
      "a key rebound to another pool's user",
      (f: Fixture) => f.db.query("UPDATE api_key SET user_id=7 WHERE id=10"),
      ["poolId", "otherId"],
    ],
    ["a deleted person", (f: Fixture) => f.db.query('DELETE FROM "user" WHERE id=8'), ["otherId"]],
    [
      "a renamed user",
      (f: Fixture) => f.db.query(`UPDATE "user" SET username='renamed' WHERE id=7`),
      ["poolId"],
    ],
    [
      "a key whose fingerprint changed",
      (f: Fixture) =>
        f.db.query("UPDATE api_key SET diagnostic_fingerprint=$1 WHERE id=9", [
          `sha256:${"d".repeat(64)}`,
        ]),
      ["poolId"],
    ],
  ] as const)
    await seriesFixture(async (f) => {
      const c = await counted(f);
      const storage = c.storage;
      assert.deepEqual((await settle(f, storage)).counts, [], label);
      const rows = await stored(f);
      await change(f);
      const { state, counts } = await settle(f, storage);
      assert.deepEqual(
        [...new Set(counts.map((block) => block.pool))].sort(),
        involved.map((name) => c[name]).sort(),
        `${label}: every pool it moved usage between, and no other`,
      );
      assert.equal(state.lastRemap?.pools, involved.length, label);
      assert.equal(await stored(f), rows, `${label}: counted again in place, none deleted`);
      assert.deepEqual((await settle(f, storage)).counts, [], `${label}: once`);
    });
});

test("a key Home creates for usage it already holds makes its pool count again, and that usage reads uncaptured", async () => {
  await seriesFixture(async (f) => {
    const repaired = `sha256:${"c".repeat(64)}`;
    // Usage on a key Home does not know yet: no pool's, so the counts leave it out.
    const c = await counted(f, async (c) => void (await c.usage(at(6, 10 * minute), repaired)));
    assert.deepEqual([...(await c.coverage(at(6), at(7))).incomplete!], []);
    await f.db.query("INSERT INTO api_key (id,diagnostic_fingerprint,user_id) VALUES (11,$1,7)", [
      repaired,
    ]);
    const { counts } = await settle(f, c.storage);
    assert.deepEqual([...new Set(counts.map((block) => block.pool))], [c.poolId]);
    assert.deepEqual([...(await c.coverage(at(6), at(7))).incomplete!], [hourKey(6)]);
  });
});

test("keys minted for app requests and probes, with no past usage, count nothing again", async () => {
  await seriesFixture(async (f) => {
    const c = await counted(f);
    // The fill's first pass counted every pool again once; nothing since.
    const last = (await settle(f, c.storage)).state.lastRemap;
    // Each app request mints its own key and uses it now, in an hour no count has settled.
    for (let n = 0; n < 3; n++) {
      const key = `sha256:${String(n).repeat(64)}`;
      await f.db.query("INSERT INTO api_key (id,diagnostic_fingerprint,user_id) VALUES ($1,$2,7)", [
        20 + n,
        key,
      ]);
      await c.usage(new Date().toISOString(), key);
      const { state, counts } = await settle(f, c.storage);
      assert.deepEqual(counts, [], `key ${n}`);
      assert.deepEqual(state.lastRemap, last, `key ${n}: no remap`);
    }
  });
});

test("a key whose usage all came after it was made counts nothing again, though that usage has settled", async () => {
  await seriesFixture(async (f) => {
    const c = await counted(f);
    const last = (await settle(f, c.storage)).state.lastRemap;
    // Made four hours ago and used an hour later: settled usage, but none older than the key, as
    // an app key's after a long gap between passes.
    const key = `sha256:${"9".repeat(64)}`;
    await f.db.query(
      "INSERT INTO api_key (id,diagnostic_fingerprint,user_id,created_at) VALUES (30,$1,7,now() - interval '4 hours')",
      [key],
    );
    await c.usage(new Date(Date.now() - 3 * hourMs).toISOString(), key);
    const { state, counts } = await settle(f, c.storage);
    assert.deepEqual(counts, []);
    assert.deepEqual(state.lastRemap, last, "no remap");
  });
});

test("a key revoked between passes counts nothing again: Home keeps its usage its owner's", async () => {
  await seriesFixture(async (f) => {
    const c = await counted(f);
    const last = (await settle(f, c.storage)).state.lastRemap;
    await f.db.query("UPDATE api_key SET deleted_at=now() WHERE id=9");
    // Two passes: the first compares the digests from before the revoke, the second the first's.
    for (const pass of [1, 2]) {
      const { state, counts } = await settle(f, c.storage);
      assert.deepEqual(counts, [], `pass ${pass}`);
      assert.deepEqual(state.lastRemap, last, `pass ${pass}: no remap`);
    }
  });
});

test("the first pass with no mapping kept counts every pool again once, in place", async () => {
  await seriesFixture(async (f) => {
    const c = await counted(f);
    const rows = await stored(f);
    const before = await checked(f, c.poolId, at(2));
    // As the tick's state stands after the timed recount, or after it was lost.
    const { counts } = await settle(f, memoryStorage());
    assert.deepEqual(
      [...new Set(counts.map((block) => block.pool))].sort(),
      [c.poolId, c.otherId].sort(),
    );
    assert.equal(await stored(f), rows, "none deleted");
    assert.ok((await checked(f, c.poolId, at(2)))! > before!);
    const older = await f.db.query(
      "SELECT count(*)::int AS n FROM basalt_model_capture_hours WHERE checked_at <= $1",
      [new Date(before!).toISOString()],
    );
    assert.equal(Number(older.rows[0]!.n), 0, "every count taken again");
  });
});
