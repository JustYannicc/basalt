import { homeMetadataFixture } from "./history-fixture.ts";
import { backendUserName } from "../../src/pool/backend-users.ts";
import { planHomeBackfill, activateHomeBackfill } from "../../src/pool/model-history/activation.ts";
import { captureHomeRequests } from "../../src/pool/model-history/capture.ts";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import pg from "pg";
import { callerHeader } from "../../apps/pool/contract.ts";
import { signPoolToken } from "../../src/pool/token.ts";
import { migrateModelHistory } from "../../src/pool/model-history/schema.ts";
import { handleUsageImport } from "../../src/pool/model-history/import-http.ts";
import { handleModelHistory } from "../../src/pool/model-history/http.ts";

const adminUrl = process.env.POOL_TEST_ADMIN_URL;
if (!adminUrl || !["localhost", "127.0.0.1"].includes(new URL(adminUrl).hostname))
  throw new Error("POOL_TEST_ADMIN_URL must point to an isolated local test Postgres cluster");

test("import requires a manager and matching dry run, deduplicates after restart, and filters history", async () => {
  const schema = `import_${randomUUID().replaceAll("-", "")}`;
  const db = new pg.Client({ connectionString: adminUrl });
  await db.connect();
  try {
    await db.query(`CREATE SCHEMA ${schema}`);
    await db.query(`SET search_path TO ${schema}`);
    await homeMetadataFixture(db);
    await migrateModelHistory(db);
    const url = new URL(adminUrl!);
    url.searchParams.set("options", `-c search_path=${schema}`);
    const signingKey = "ab".repeat(32), pool = "fixture-pool", owner = "fixture-owner";
    const token = await signPoolToken(signingKey, { pool, owner, organization: "fixture-organization" });
    const access = { signingKey, connectionString: url.toString(), permissions: async (_pool: string, caller: string) =>
      ({ canUse: caller !== "removed", canManage: caller === owner }) };
    const payload = { source: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee", format: "home-v8-jsonl", data: JSON.stringify({
      usage_id: 1, request_id: randomUUID(), timestamp: "2020-01-01T12:00:00Z", provider: "fixture-provider",
      model: "fixture-model", failed: false, status_code: 200, input_tokens: 100, output_tokens: 10,
      cached_tokens: 20, cache_creation_tokens: 0, reasoning_tokens: 3, total_tokens: 110, latency_ms: 25,
      endpoint: "/v1/responses", amount: null, error_body_preview: "fixture-response-sentinel",
    }) };
    const request = (body: object, caller = owner, authorized = true) => new Request("https://pool.example.test/pool/v1/usage/import", {
      method: "POST", headers: { ...(authorized ? { authorization: `Bearer ${token}` } : {}), [callerHeader]: caller,
        "content-type": "application/json" }, body: JSON.stringify(body),
    });
    assert.equal((await handleUsageImport(request(payload, owner, false), access)).status, 401);
    assert.equal((await handleUsageImport(request(payload, "member"), access)).status, 403);
    assert.equal((await handleUsageImport(request(payload, "removed"), access)).status, 403);
    assert.equal((await handleUsageImport(request({ ...payload, mode: "apply" }), access)).status, 409);
    const dry = await handleUsageImport(request(payload), access);
    assert.equal(dry.status, 200, await dry.clone().text());
    const report = await dry.json() as { approval: string; wouldInsert: number };
    assert.equal(report.wouldInsert, 1);
    assert.equal((await db.query("SELECT count(*)::text AS n FROM basalt_model_requests")).rows[0].n, "0");
    const changed = await handleUsageImport(request({ ...payload, data: payload.data.replace('"input_tokens":100', '"input_tokens":101'),
      mode: "apply", approval: report.approval }), access);
    assert.equal(changed.status, 409);
    for (let boot = 0; boot < 2; boot++) {
      const response = await handleUsageImport(request({ ...payload, mode: "apply", approval: report.approval }), { ...access });
      assert.equal(response.status, 200, await response.clone().text());
      const outcome = await response.json() as { inserted: number };
      assert.equal(outcome.inserted, boot === 0 ? 1 : 0);
    }
    const history = (caller: string) => handleModelHistory(new Request(
      "https://pool.example.test/pool/v1/usage/history?from=2019-01-01T00:00:00Z&to=2021-01-01T00:00:00Z", {
        headers: { authorization: `Bearer ${token}`, [callerHeader]: caller },
      }), access);
    const own = await history(owner);
    assert.equal(own.status, 200);
    const retained = await own.text();
    assert.match(retained, /fixture-model/);
    assert.doesNotMatch(retained, /fixture-response-sentinel/);
    assert.equal((await (await history("member")).json() as { records: unknown[] }).records.length, 0);
    assert.equal((await history("removed")).status, 403);
    await db.query('INSERT INTO "user" VALUES (1,$1)', [await backendUserName("member", pool)]);
    await db.query("INSERT INTO api_key VALUES (1,$1,1)", [`sha256:${"a".repeat(64)}`]);
    const localPayload = { ...payload, source: "home-local-v1" };
    const importBatch = async (body: typeof payload, expected: number) => {
      const dry = await handleUsageImport(request(body), access);
      assert.equal(dry.status, 200, await dry.clone().text());
      const report = await dry.json() as { approval: string; wouldInsert: number };
      assert.equal(report.wouldInsert, expected);
      for (let restart = 0; restart < 2; restart++) {
        const applied = await handleUsageImport(request({ ...body, mode: "apply", approval: report.approval }), { ...access });
        assert.equal(applied.status, 200, await applied.clone().text());
        assert.equal((await applied.json() as { inserted: number }).inserted, restart === 0 ? expected : 0);
      }
    };
    for (const captureFirst of [false, true]) {
      const requestId = randomUUID();
      await db.query(`INSERT INTO usage (timestamp,request_id,model,api_key,failed)
        VALUES ('2020-01-01T12:00:00Z',$1,'fixture-model',$2,false)`, [requestId, `sha256:${"a".repeat(64)}`]);
      if (captureFirst) await captureHomeRequests(db);
      // Also exercise automatic reconciliation for an uploaded export's ordinary source UUID.
      await importBatch({ ...payload, data: JSON.stringify({ ...JSON.parse(payload.data), request_id: requestId }) }, captureFirst ? 0 : 1);
      if (!captureFirst) {
        await activateHomeBackfill(db, await planHomeBackfill(db));
        await captureHomeRequests(db);
      }
      await importBatch({ ...localPayload, data: JSON.stringify({ ...JSON.parse(payload.data), request_id: requestId }) }, 0);
      assert.equal((await db.query("SELECT count(*)::text AS n FROM basalt_model_requests WHERE request_id=$1", [requestId])).rows[0].n, "1");
    }
    assert.equal((await (await history("member")).json() as { records: unknown[] }).records.length, 2,
      "local imports preserve the request's member instead of assigning the manager");
    const old = await db.query(`INSERT INTO usage (timestamp,model,api_key,failed)
      VALUES ('2020-01-01T12:00:00Z',NULL,$1,false) RETURNING id::text`, [`sha256:${"a".repeat(64)}`]);
    const oldId = String(old.rows[0].id);
    const oldPayload = { ...localPayload, data: JSON.stringify({ ...JSON.parse(payload.data), request_id: null,
      usage_id: oldId, model: null }) };
    await importBatch(oldPayload, 1);
    await captureHomeRequests(db);
    await db.query("DELETE FROM usage WHERE id=$1", [oldId]);
    await importBatch(oldPayload, 0);
    const missing = await handleUsageImport(request({ ...localPayload,
      data: JSON.stringify({ ...JSON.parse(payload.data), request_id: randomUUID(), usage_id: 999999 }) }), access);
    assert.equal(missing.status, 400, "an explicit local source cannot invent an absent Home request");
    const foreignKey = "b".repeat(64), foreignId = randomUUID();
    await db.query('INSERT INTO "user" VALUES (2,$1)', [await backendUserName("foreign-member", "foreign-pool")]);
    await db.query("INSERT INTO api_key VALUES (2,$1,2)", [`sha256:${foreignKey}`]);
    await db.query(`INSERT INTO usage (timestamp,request_id,model,api_key,failed)
      VALUES ('2020-01-01T12:00:00Z',$1,'fixture-model',$2,false)`, [foreignId, `sha256:${foreignKey}`]);
    const stolen = await handleUsageImport(request({ ...localPayload,
      data: JSON.stringify({ ...JSON.parse(payload.data), request_id: foreignId }) }), access);
    assert.equal(stolen.status, 409, "local source resolution cannot claim another pool's request");
  } finally {
    await db.query(`DROP SCHEMA ${schema} CASCADE`);
    await db.end();
  }
});
