import assert from "node:assert/strict";
import { test } from "node:test";
import { callerHeader } from "../../apps/pool/contract.ts";
import { signPoolToken } from "../../src/pool/token.ts";
import { parseUsageImport } from "../../src/pool/model-history/import.ts";
import { handleUsageImport } from "../../src/pool/model-history/import-http.ts";
import { poolUsageSeries } from "../../src/pool/model-history/series.ts";
import { lastSuccessAt } from "../../src/pool/model-history/last-success.ts";
import { accountAuthority, full, input, pool, seriesFixture } from "./series-fixture.ts";

const owner = "fixture-owner";
const source = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const sourceAccountRef = "a".repeat(64);
const mapping = { sourceAccountRef, targetAccountId: "current-credential", provider: "codex" };
const event = {
  event_hash: "b".repeat(64),
  timestamp: "2026-01-01T00:30:00Z",
  failed: false,
  provider: "codex",
  model: "fixture-model",
  account_ref: sourceAccountRef,
  input_tokens: "100",
  output_tokens: "10",
  total_tokens: "110",
};
const payload = { source, format: "cpamp-v1-jsonl", data: JSON.stringify(event) };

test("optional account mapping preserves unmapped records and immutable event identities", async () => {
  const context = { pool, person: owner };
  const plain = await parseUsageImport(payload, context);
  const empty = await parseUsageImport({ ...payload, accountMappings: [] }, context);
  assert.deepEqual(empty.records, plain.records);
  assert.equal(Object.hasOwn(plain, "accountMappings"), false);
  const native = await accountAuthority();
  const mapped = await parseUsageImport({ ...payload, accountMappings: [mapping] }, context);
  assert.deepEqual(mapped.records, [{ ...plain.records[0]!, account: native.visible }]);
  assert.notEqual(mapped.digest, plain.digest);
  const unrelated = await parseUsageImport(
    { ...payload, accountMappings: [{ ...mapping, sourceAccountRef: "c".repeat(64) }] },
    context,
  );
  assert.deepEqual(unrelated.records, plain.records);
  for (const change of [
    { accountMappings: [mapping, mapping] },
    { accountMappings: [{ ...mapping, provider: "claude" }] },
    { accountMappings: [{ ...mapping, sourceAccountRef: "raw-login" }] },
    { accountMappings: [mapping], format: "home-v8-jsonl" },
  ])
    await assert.rejects(parseUsageImport({ ...payload, ...change }, context));
});

test("mapped imports feed account counts, ticks, success, window tokens and last-success; replay cannot remap", async () => {
  await seriesFixture(async ({ db, schema, insert }) => {
    const url = new URL(process.env.POOL_TEST_ADMIN_URL!);
    url.searchParams.set("options", `-c search_path=${schema}`);
    const signingKey = "ab".repeat(32);
    const token = await signPoolToken(signingKey, { pool, owner, organization: "fixture-org" });
    let targets = [
      { id: "current-credential", provider: "codex" },
      { id: "private-credential", provider: "codex" },
    ];
    const access = {
      signingKey,
      connectionString: url.toString(),
      permissions: async () => ({ canUse: true, canManage: true }),
      importAccounts: async () => targets,
    };
    const request = (body: object) =>
      new Request("https://pool.example.test/pool/v1/usage/import", {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, [callerHeader]: owner },
        body: JSON.stringify(body),
      });
    const post = (body: object) => handleUsageImport(request(body), access);
    const mappedPayload = {
      ...payload,
      accountMappings: [mapping],
      data: [
        event,
        { ...event, event_hash: "c".repeat(64), timestamp: "2026-01-01T01:30:00Z", failed: true },
      ]
        .map((row) => JSON.stringify(row))
        .join("\n"),
    };
    const dry = await post(mappedPayload);
    assert.equal(dry.status, 200, await dry.clone().text());
    const report = (await dry.json()) as { approval: string; wouldInsert: number; ids: string[] };
    assert.equal(report.wouldInsert, 2);
    assert.equal(
      (await db.query("SELECT count(*)::int AS n FROM basalt_model_requests")).rows[0].n,
      0,
    );
    const changed = {
      ...mappedPayload,
      accountMappings: [{ ...mapping, targetAccountId: "private-credential" }],
    };
    assert.equal(
      (await post({ ...changed, mode: "apply", approval: report.approval })).status,
      409,
    );
    targets = [];
    assert.equal(
      (await post({ ...mappedPayload, mode: "apply", approval: report.approval })).status,
      400,
      "membership is revalidated at apply",
    );
    targets = [{ id: "current-credential", provider: "claude" }];
    assert.equal((await post(mappedPayload)).status, 400);
    targets = [
      { id: "current-credential", provider: "codex" },
      { id: "private-credential", provider: "codex" },
    ];
    for (const expected of [2, 0]) {
      const response = await post({ ...mappedPayload, mode: "apply", approval: report.approval });
      assert.equal(response.status, 200, await response.clone().text());
      assert.equal(((await response.json()) as { inserted: number }).inserted, expected);
    }
    assert.equal(
      (await post(changed)).status,
      409,
      "retained event content refuses a fresh remap dry run",
    );
    assert.equal(
      (await post(payload)).status,
      409,
      "omitting the map cannot replace mapped content",
    );
    const native = await accountAuthority();
    await insert({ account: native.visible, failed: false, attribution: "unknown" });
    const selected = {
      ...input,
      from: "2025-12-26T00:00:00Z",
      accounts: ["saved-visible"],
      by: ["account"],
    };
    const series = await poolUsageSeries(db, selected, native.authority);
    assert.equal(series.groups[0]!.key.account, "saved-visible");
    const buckets = series.groups[0]!.buckets.map(full);
    assert.equal(
      buckets.reduce((n, bucket) => n + bucket.requests, 0),
      2,
      "seven-day card count excludes unrelated foreign rows",
    );
    assert.deepEqual(
      buckets.map((bucket) => bucket.requests),
      [1, 1],
    );
    assert.deepEqual(
      buckets.map((bucket) => bucket.successRate),
      [1, 0],
    );
    assert.equal(
      buckets.reduce((n, bucket) => n + BigInt(bucket.tokens.total.sum!), 0n),
      220n,
    );
    const window = await poolUsageSeries(
      db,
      { ...selected, window: { from: "2026-01-01T00:00:00Z", to: "2026-01-01T01:00:00Z" } },
      native.authority,
    );
    assert.equal(full(window.groups[0]!.buckets[0]).tokens.total.sum, "110");
    const latest = await lastSuccessAt(db, { pool, accounts: ["saved-visible"] }, native.authority);
    assert.equal(latest.accounts[0]!.lastSuccessAt, "2026-01-01T00:30:00.000000000Z");
    const closed = await poolUsageSeries(db, selected, {
      ...native.authority,
      mappingProven: false,
    });
    assert.deepEqual(closed.groups, []);

    const plain = { ...payload, data: JSON.stringify({ ...event, event_hash: "d".repeat(64) }) };
    const plainDry = await post(plain);
    assert.equal(plainDry.status, 200);
    const plainReport = (await plainDry.json()) as { approval: string };
    const applied = await post({ ...plain, mode: "apply", approval: plainReport.approval });
    assert.equal(applied.status, 200);
    const foreign = await poolUsageSeries(db, { ...input, by: ["account"] }, native.authority);
    assert.equal(
      foreign.groups.find((group) => group.key.account === "unmapped")!.buckets[0]!.requests,
      2,
    );

    await insert({
      account: native.hidden,
      attribution: "import-owner",
      provider: "private-provider-sentinel",
      totalTokens: "999999",
    });
    const privateSeries = await poolUsageSeries(
      db,
      { ...input, by: ["account", "provider"] },
      native.authority,
    );
    const other = privateSeries.groups.find((group) => group.key.account === "otherAccounts")!;
    assert.equal(other.buckets[0]!.requests, 1);
    assert.equal(Object.hasOwn(other.buckets[0]!, "tokens"), false);
    assert.doesNotMatch(JSON.stringify(privateSeries), /private-provider-sentinel|999999/);
  });
});
