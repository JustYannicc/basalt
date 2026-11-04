import assert from "node:assert/strict";
import { test } from "node:test";
import { signEnvelope, signPoolToken } from "../../src/pool/token.ts";
import { digest } from "../../src/pool/backend-users.ts";
import {
  handleUsageSeries,
  lastSuccessAtPath,
  poolPersonalOverviewPath,
  poolUsageSeriesPath,
} from "../../src/pool/model-history/series-http.ts";
import { input, seriesFixture } from "./series-fixture.ts";

const signingKey = "ab".repeat(32);
const request = async (
  action: "poolUsageSeries" | "lastSuccessAt",
  changes: Record<string, unknown> = {},
) =>
  new Request(
    `https://pool.example.test${action === "poolUsageSeries" ? poolUsageSeriesPath : lastSuccessAtPath}`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        envelope: await signEnvelope(signingKey, "sbs1", {
          action,
          pool: input.pool,
          user: "fixture-manager",
          organization: "fixture-organization",
          expiresAt: Date.now() + 30_000,
          input: action === "poolUsageSeries" ? input : { pool: input.pool, accounts: [] },
          authority: { canManage: true, accounts: [] },
          ...changes,
        }),
      }),
    },
  );

test("the signed pool transport executes one bounded aggregate read against the real database and keeps missing values", async () => {
  await seriesFixture(async ({ schema, insert }) => {
    await insert(
      { inputTokens: "9007199254740993", outputTokens: "0" },
      { inputTokens: null, failed: true },
    );
    const url = new URL(process.env.POOL_TEST_ADMIN_URL!);
    url.searchParams.set("options", `-c search_path=${schema}`);
    const access = { signingKey, connectionString: url.toString() };
    const response = await handleUsageSeries(await request("poolUsageSeries"), access);
    assert.equal(response.status, 200, await response.clone().text());
    const result = await response.json();
    assert.equal(result.groups.length, 1);
    const bucket = result.groups[0].buckets[0];
    assert.deepEqual(bucket.tokens.input, { sum: "9007199254740993", known: 1, missing: 1 });
    assert.deepEqual(bucket.tokens.output, { sum: "0", known: 1, missing: 1 });
    assert.equal(bucket.cost.homeCharge.amount, null);
    assert.equal(bucket.cost.apiEquivalent.status, "unavailable");
    assert.equal(bucket.successRate, 0.5);
    assert.equal(result.next, null);
    assert.ok(result.asOf);
    assert.ok(Buffer.byteLength(JSON.stringify(result)) <= 1_048_576);
    const latest = await handleUsageSeries(await request("lastSuccessAt"), access);
    assert.equal(latest.status, 200);
    assert.deepEqual((await latest.json()).accounts, []);
    assert.equal(
      (
        await handleUsageSeries(
          await request("poolUsageSeries", { input: { ...input, accounts: ["not-permitted"] } }),
          access,
        )
      ).status,
      403,
    );
    assert.equal(
      (
        await handleUsageSeries(
          await request("poolUsageSeries", { input: { ...input, pool: "another-pool" } }),
          access,
        )
      ).status,
      400,
    );
  });
});

test("ordinary pool tokens, non-management assertions, expired assertions and cross-method assertions cannot read usage", async () => {
  const access = { signingKey, connectionString: undefined };
  const ordinary = new Request(`https://pool.example.test${poolUsageSeriesPath}`, {
    method: "POST",
    body: JSON.stringify({
      envelope: await signPoolToken(signingKey, {
        pool: input.pool,
        owner: "fixture-owner",
        organization: "fixture-org",
      }),
    }),
  });
  assert.equal((await handleUsageSeries(ordinary, access)).status, 401);
  assert.equal(
    (
      await handleUsageSeries(
        await request("poolUsageSeries", { authority: { canManage: false, accounts: [] } }),
        access,
      )
    ).status,
    403,
  );
  assert.equal(
    (
      await handleUsageSeries(
        await request("poolUsageSeries", { expiresAt: Date.now() - 1 }),
        access,
      )
    ).status,
    401,
  );
  assert.equal(
    (await handleUsageSeries(await request("poolUsageSeries", { action: "lastSuccessAt" }), access))
      .status,
    401,
  );
  assert.equal(
    (
      await handleUsageSeries(
        new Request(`https://pool.example.test${poolUsageSeriesPath}`),
        access,
      )
    ).status,
    404,
  );
});

test("personal overview binds its signed person to the authenticated host user and rejects manager authority", async () => {
  const user = "fixture-member";
  const personalInput = { pool: input.pool, person: await digest("different-member"), from: input.from, to: input.to, days: 7, offerings: [] };
  const signed = async (changes: Record<string, unknown> = {}) => new Request(`https://pool.example.test${poolPersonalOverviewPath}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ envelope: await signEnvelope(signingKey, "sbs1", {
      action: "poolPersonalOverview", pool: input.pool, user, organization: "fixture-organization",
      expiresAt: Date.now() + 30_000, input: personalInput, ...changes,
    }) }),
  });
  const access = { signingKey, connectionString: undefined };
  assert.equal((await handleUsageSeries(await signed(), access)).status, 401);
  assert.equal((await handleUsageSeries(await signed({ input: { ...personalInput, person: await digest(user) }, authority: { canManage: true, accounts: [] } }), access)).status, 401);
  assert.equal((await handleUsageSeries(await signed({ input: { ...personalInput, person: await digest(user), accounts: ["private-account"] } }), access)).status, 400);
});
