import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import pg from "pg";
import { callerHeader } from "../../apps/pool/contract.ts";
import { digest } from "../../src/pool/backend-users.ts";
import { migrateModelHistory } from "../../src/pool/model-history/schema.ts";
import { handleSelfUsageImport } from "../../src/pool/model-history/self-import-http.ts";
import { signPoolToken } from "../../src/pool/token.ts";
import { historySchemaFixture, homeMetadataFixture } from "./history-fixture.ts";

const adminUrl = (() => {
  try {
    const configured = process.env.POOL_TEST_ADMIN_URL;
    return configured && ["localhost", "127.0.0.1"].includes(new URL(configured).hostname)
      ? configured
      : undefined;
  } catch {
    return undefined;
  }
})();

// Release each read before the next HTTP request, including single-session Postgres fixtures.
async function querySaved(connectionString: string, text: string) {
  const client = new pg.Client({ connectionString });
  try {
    await client.connect();
    return await client.query(text);
  } finally {
    await client.end();
  }
}

test(
  "self imports require a manager and matching approval, then stay unpriced and unattributed",
  {
    skip: !adminUrl,
  },
  async () => {
    const schema = `self_import_${randomUUID().replaceAll("-", "")}`;
    const db = new pg.Client({ connectionString: adminUrl });
    await db.connect();
    try {
      await historySchemaFixture(db, schema);
      await db.query(`SET search_path TO ${schema}`);
      await homeMetadataFixture(db);
      await migrateModelHistory(db);
      const url = new URL(adminUrl!);
      url.searchParams.set("options", `-c search_path=${schema}`);
      await db.end();
      const signingKey = "ab".repeat(32),
        pool = "fixture-pool",
        owner = "fixture-owner";
      const token = await signPoolToken(signingKey, {
        pool,
        owner,
        organization: "fixture-organization",
      });
      const access = {
        signingKey,
        connectionString: url.toString(),
        permissions: async (_pool: string, caller: string) => ({
          canUse: caller !== "removed",
          canManage: caller === owner || caller === "second-manager",
        }),
      };
      const event = {
        event_hash: "a".repeat(64),
        timestamp: "2026-05-05T11:32:18.619000001Z",
        failed: false,
        provider: "fixture-provider",
        model: "fixture-model",
        endpoint: "/v1/responses",
        input_tokens: "100",
        output_tokens: "10",
        total_tokens: "110",
        status_code: 200,
        account_ref: "fixture-private-account-reference",
        client_key_ref: "fixture-private-key-reference",
        raw_json: "fixture-private-payload-sentinel",
        amount: "999",
        currency: "USD",
      };
      const payload = {
        format: "cpamp-v1-jsonl",
        data: JSON.stringify(event),
        offset: 0,
        mode: "dry-run",
      };
      const request = (body: object, caller = owner, authorized = true) =>
        new Request("https://pool.example.test/pool/v1/usage/import/self", {
          method: "POST",
          headers: {
            ...(authorized ? { authorization: `Bearer ${token}` } : {}),
            [callerHeader]: caller,
            "content-type": "application/json",
          },
          body: JSON.stringify({ source: "fixture-database", ...body }),
        });

      assert.equal(
        (await handleSelfUsageImport(request(payload, owner, false), access)).status,
        401,
      );
      assert.equal((await handleSelfUsageImport(request(payload, "member"), access)).status, 403);
      assert.equal((await handleSelfUsageImport(request(payload, "removed"), access)).status, 403);
      const noCaller = request(payload);
      noCaller.headers.delete(callerHeader);
      assert.equal((await handleSelfUsageImport(noCaller, access)).status, 403);
      assert.equal(
        (
          await handleSelfUsageImport(
            request({
              ...payload,
              source: "caller-selected-source",
              pool: "forged-pool",
              person: "forged-person",
              prices: [{ provider: "fixture-provider", model: "fixture-model", input: "0" }],
            }),
            access,
          )
        ).status,
        400,
      );

      const dry = await handleSelfUsageImport(request(payload), access);
      assert.equal(dry.status, 200, await dry.clone().text());
      const report = (await dry.clone().json()) as {
        approval: string;
        wouldInsert: number;
        unpriced: number;
        from: string;
        to: string;
      };
      assert.equal(report.wouldInsert, 1);
      assert.equal(report.unpriced, 1);
      assert.equal(report.from, event.timestamp);
      assert.equal(report.to, event.timestamp);
      assert.doesNotMatch(await dry.text(), /fixture-private/);
      assert.equal(
        (await querySaved(url.toString(), "SELECT count(*)::text AS n FROM basalt_model_requests"))
          .rows[0]!.n,
        "0",
      );

      const changed = await handleSelfUsageImport(
        request({
          ...payload,
          data: JSON.stringify({ ...event, input_tokens: "101" }),
          mode: "apply",
          approval: report.approval,
        }),
        access,
      );
      assert.equal(changed.status, 409);

      const apply = { ...payload, mode: "apply", approval: report.approval };
      assert.equal(
        (await handleSelfUsageImport(request(apply, "second-manager"), access)).status,
        409,
        "a second manager cannot reuse the first manager's approval",
      );
      const first = await handleSelfUsageImport(request(apply), access);
      assert.equal(first.status, 200, await first.clone().text());
      assert.equal(((await first.json()) as { inserted: number }).inserted, 1);
      const repeat = await handleSelfUsageImport(request(apply), access);
      assert.equal(repeat.status, 200, await repeat.clone().text());
      assert.equal(((await repeat.json()) as { inserted: number; existing: number }).inserted, 0);

      const secondManagerDry = await handleSelfUsageImport(
        request(payload, "second-manager"),
        access,
      );
      assert.equal(secondManagerDry.status, 200, await secondManagerDry.clone().text());
      assert.equal(
        ((await secondManagerDry.json()) as { wouldInsert: number; existing: number }).wouldInsert,
        0,
      );

      const homeDry = await handleSelfUsageImport(
        request({
          format: "home-v8-jsonl",
          data: JSON.stringify({
            usage_id: 7,
            timestamp: "2020-01-01T00:00:00Z",
            failed: false,
            provider: "fixture-provider",
            model: "fixture-model",
            amount: "not-a-price",
            currency: { private: "billing-sentinel" },
            matched_price_rule: { private: "rule-sentinel" },
          }),
          mode: "dry-run",
        }),
        access,
      );
      assert.equal(homeDry.status, 200, await homeDry.clone().text());
      assert.equal(((await homeDry.json()) as { unpriced: number }).unpriced, 1);

      const saved = await querySaved(
        url.toString(),
        `SELECT pool,person,cost::text,currency,cost_basis,price_version,
      price_snapshot,original_price_rule,attribution FROM basalt_model_requests`,
      );
      assert.deepEqual(saved.rows, [
        {
          pool: (await digest(pool)).slice(0, 16),
          person: null,
          cost: null,
          currency: null,
          cost_basis: "unpriced",
          price_version: null,
          price_snapshot: null,
          original_price_rule: null,
          attribution: "import-owner",
        },
      ]);
      const fullPage = {
        ...payload,
        offset: 400,
        data: Array.from({ length: 200 }, (_, index) =>
          JSON.stringify({ ...event, event_hash: (index + 2).toString(16).padStart(64, "0") }),
        ).join("\n"),
      };
      const fullDry = await handleSelfUsageImport(request(fullPage), access);
      assert.equal(fullDry.status, 200, await fullDry.clone().text());
      const fullReport = (await fullDry.json()) as {
        approval: string;
        pageDetails: number;
        totalDetails: number;
        next: number;
      };
      assert.deepEqual(
        [fullReport.pageDetails, fullReport.totalDetails, fullReport.next],
        [200, 600, 600],
      );
      const shifted = await handleSelfUsageImport(
        request({ ...fullPage, offset: 401, mode: "apply", approval: fullReport.approval }),
        access,
      );
      assert.equal(shifted.status, 409, "approval includes the absolute offset");
      const fullApply = await handleSelfUsageImport(
        request({ ...fullPage, mode: "apply", approval: fullReport.approval }),
        access,
      );
      assert.equal(fullApply.status, 200, await fullApply.clone().text());
      assert.equal(((await fullApply.json()) as { inserted: number }).inserted, 200);
      const otherSource = { ...payload, source: "another-database" };
      const otherDry = await handleSelfUsageImport(request(otherSource), access);
      assert.equal(otherDry.status, 200);
      const otherReport = (await otherDry.json()) as { approval: string; wouldInsert: number };
      assert.equal(
        otherReport.wouldInsert,
        1,
        "overlapping record IDs in another database stay distinct",
      );
      const wrongSource = await handleSelfUsageImport(
        request({
          ...otherSource,
          source: "third-database",
          mode: "apply",
          approval: otherReport.approval,
        }),
        access,
      );
      assert.equal(wrongSource.status, 409, "approval binds the named source database");
      const otherApply = await handleSelfUsageImport(
        request({ ...otherSource, mode: "apply", approval: otherReport.approval }),
        access,
      );
      assert.equal(otherApply.status, 200);
      assert.equal(((await otherApply.json()) as { inserted: number }).inserted, 1);
    } finally {
      await db.end();
      await querySaved(adminUrl!, `DROP SCHEMA ${schema} CASCADE`);
    }
  },
);

test(
  "legacy CPA snapshots retain aggregate gaps and server-side offsets",
  {
    skip: !adminUrl,
  },
  async () => {
    const schema = `self_cpa_${randomUUID().replaceAll("-", "")}`;
    const db = new pg.Client({ connectionString: adminUrl });
    await db.connect();
    try {
      await historySchemaFixture(db, schema);
      await db.query(`SET search_path TO ${schema}`);
      await homeMetadataFixture(db);
      await migrateModelHistory(db);
      const url = new URL(adminUrl!);
      url.searchParams.set("options", `-c search_path=${schema}`);
      await db.end();
      const signingKey = "cd".repeat(32),
        pool = "fixture-cpa-pool",
        owner = "fixture-cpa-owner";
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
      const detail = {
        timestamp: "2020-01-01T12:00:00.123456789Z",
        auth_index: "fixture-account",
        source: "fixture-private-source-reference",
        failed: false,
        tokens: {
          input_tokens: 100,
          output_tokens: 10,
          cached_tokens: 20,
          reasoning_tokens: 3,
          total_tokens: 110,
        },
      };
      const data = JSON.stringify({
        version: 0,
        usage: {
          total_requests: 5,
          apis: {
            "fixture-private-api-key": {
              models: {
                "fixture-model": {
                  total_requests: 5,
                  details: [
                    detail,
                    detail,
                    { ...detail, timestamp: "2020-01-01T12:00:00.223456789Z" },
                  ],
                },
              },
            },
          },
        },
      });
      const request = (offset: number) =>
        new Request("https://pool.example.test/pool/v1/usage/import/self", {
          method: "POST",
          headers: {
            authorization: `Bearer ${token}`,
            [callerHeader]: owner,
            "content-type": "application/json",
          },
          body: JSON.stringify({
            source: "fixture-database",
            format: "cpa-v6",
            data,
            offset,
            mode: "dry-run",
          }),
        });
      const first = await handleSelfUsageImport(request(0), access);
      assert.equal(first.status, 200, await first.clone().text());
      const firstReport = (await first.clone().json()) as {
        totalDetails: number;
        pageDetails: number;
        next: number | null;
        aggregateOnlyNotImportable: string;
      };
      assert.equal(firstReport.totalDetails, 3);
      assert.equal(firstReport.pageDetails, 3);
      assert.equal(firstReport.next, null);
      assert.equal(firstReport.aggregateOnlyNotImportable, "2");
      assert.doesNotMatch(await first.text(), /fixture-private/);

      const next = await handleSelfUsageImport(request(1), access);
      assert.equal(next.status, 200, await next.clone().text());
      const nextReport = (await next.json()) as {
        pageDetails: number;
        indistinguishableDetails: number;
      };
      assert.equal(nextReport.pageDetails, 2);
      assert.equal(nextReport.indistinguishableDetails, 1);
      assert.equal(
        (await querySaved(url.toString(), "SELECT count(*)::text AS n FROM basalt_model_requests"))
          .rows[0]!.n,
        "0",
      );
    } finally {
      await db.end();
      await querySaved(adminUrl!, `DROP SCHEMA ${schema} CASCADE`);
    }
  },
);
