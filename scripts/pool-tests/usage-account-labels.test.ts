import assert from "node:assert/strict";
import { test } from "node:test";
import { digest } from "../../src/pool/backend-users.ts";
import { poolUsageSeries } from "../../src/pool/model-history/series.ts";
import { accountAuthority, authority, input, pool, seriesFixture } from "./series-fixture.ts";

test("foreign accounts stay separate opaque identities, labels join only account groups, and the ledger stays unchanged", async () => {
  await seriesFixture(async ({ db, insert }) => {
    const source = await digest("fixture-import");
    const foreign = await digest("old-subscription");
    const second = await digest("another-subscription");
    await insert(
      { account: foreign, inputTokens: "3" },
      { account: second, inputTokens: "5" },
      { account: null, inputTokens: "7" },
    );
    const before = await db.query("SELECT * FROM basalt_model_requests ORDER BY id");
    const opaque = `imported:${await digest(`${(await digest(pool)).slice(0, 16)}:${source}:${foreign}`)}`;
    const labels = { [opaque]: "Archive subscription" };
    const result = await poolUsageSeries(
      db,
      { ...input, by: ["account"] },
      authority,
      "owned",
      undefined,
      labels,
    );
    assert.equal(result.groups.length, 3);
    assert.deepEqual(result.groups.find((g) => g.key.account === opaque)?.accountDisplay, {
      kind: "imported-only",
      label: "Archive subscription",
    });
    assert.deepEqual(result.groups.find((g) => g.key.account === null)?.accountDisplay, {
      kind: "no-account-recorded",
      label: null,
    });
    assert.equal(
      result.groups.reduce((n, g) => n + g.buckets.reduce((n, b) => n + b.requests, 0), 0),
      3,
    );
    assert.equal(result.coverage.mapping.unmapped, 2);
    assert.equal(result.coverage.mapping.mapped, 0);
    assert.ok(!JSON.stringify(result).includes(foreign));
    assert.ok(!JSON.stringify(result).includes(second));
    const totals = await poolUsageSeries(db, input, authority, "owned", undefined, labels);
    assert.equal(totals.groups[0]?.buckets[0]?.requests, 3);
    assert.ok(!JSON.stringify(totals).includes("Archive subscription"));
    assert.ok(totals.groups.every((g) => g.accountDisplay === undefined));
    assert.deepEqual(
      (await db.query("SELECT * FROM basalt_model_requests ORDER BY id")).rows,
      before.rows,
    );
    const otherPool = await poolUsageSeries(
      db,
      { ...input, pool: "another-pool", by: ["account"] },
      authority,
      "owned",
      undefined,
      labels,
    );
    assert.deepEqual(otherPool.groups, []);
  });
});

test("native private accounts retain counts-only redaction and never receive imported display labels", async () => {
  await seriesFixture(async ({ db, insert }) => {
    const native = await accountAuthority();
    await insert({
      source: native.source,
      account: native.hidden,
      provider: "private",
      inputTokens: "42",
    });
    const result = await poolUsageSeries(
      db,
      { ...input, by: ["account", "provider"] },
      native.authority,
      "owned",
      undefined,
      { otherAccounts: "Must stay private" },
    );
    assert.equal(result.groups[0]?.key.account, "otherAccounts");
    assert.equal(result.groups[0]?.accountDisplay, undefined);
    assert.equal(result.groups[0]?.key.provider, null);
    assert.ok(!JSON.stringify(result).includes("Must stay private"));
    assert.ok(!("tokens" in result.groups[0]!.buckets[0]!));
  });
});
