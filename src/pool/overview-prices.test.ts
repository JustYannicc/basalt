import assert from "node:assert/strict";
import { test } from "node:test";
import { HomeClient } from "./control.ts";
import { OverviewPrices } from "./overview-prices.ts";
import type { Json } from "./json.ts";
import type { PriceTarget } from "./price-aliases.ts";

const start = Date.parse("2026-11-12T08:00:00Z");
const target = { provider: "openai", model: "gpt-6.1-sol" };
const official = { input: 2, output: 10, cache_read: 0.1, cache_write: 2.5, request: 0 };
const row = (wanted: PriceTarget, min = 0) => ({
  ...wanted,
  service_tier: "*",
  min_input_tokens: min,
  status: "matched",
  official,
  final: { ...official, input: 200 },
  existing_rule: { input_price_per_million: 999 },
});

function fixture() {
  const values = new Map<string, unknown>();
  const storage = {
    async get<T>(key: string) {
      return structuredClone(values.get(key)) as T | undefined;
    },
    async put(key: string, value: unknown) {
      values.set(key, structuredClone(value));
    },
  };
  let now = start,
    failing = false,
    invalidBand = false,
    stale = false;
  let version = "v1";
  let extra = false;
  const requests: Record<string, unknown>[] = [];
  const client = new HomeClient(async (_path, init) => {
    const body = JSON.parse(String(init?.body)) as Record<string, unknown> & {
      targets: PriceTarget[];
    };
    requests.push(body);
    if (failing) throw new Error("offline");
    // This is the real producer ordering: Home stamps fetched_at after the caller starts its read.
    now += 500;
    const rows: Json[] = body.targets.flatMap((wanted) =>
      wanted.model === target.model || extra ? [row(wanted)] : [{ ...wanted, status: "unmatched" }],
    );
    if (invalidBand) rows.push({ ...target, min_input_tokens: 272001, status: "unsupported" });
    return Response.json({
      source: "models.dev",
      atomic: true,
      source_version: version,
      source_fetched_at: new Date(now - (stale ? 2 * 86_400_000 : 0)).toISOString(),
      rows,
    });
  });
  const create = () => new OverviewPrices(client, storage, () => now);
  return {
    prices: create(),
    create,
    requests,
    advance(ms: number) {
      now += ms;
    },
    fail() {
      failing = true;
    },
    recover() {
      failing = false;
      version = "v2";
    },
    invalid() {
      invalidBand = true;
    },
    stale() {
      stale = true;
    },
    addModel() {
      extra = true;
      version = "new-model";
    },
  };
}

test("a normal fetched-at after request start is accepted, using official rates, never Home multipliers", async () => {
  const f = fixture();
  const prices = await f.prices.read([target]);
  assert.equal(prices.length, 1);
  assert.equal(prices[0]!.input, "2");
  assert.equal(prices[0]!.output, "10");
  assert.equal(prices[0]!.asOf, new Date(start + 500).toISOString());
  await f.prices.read([target]);
  assert.equal(f.requests.length, 1);
});

test("refresh failure keeps the last good rates through restart and retries without blanking", async (t) => {
  t.mock.method(console, "error", () => {});
  const f = fixture();
  const original = await f.prices.read([target]);
  f.advance(86_400_000);
  f.fail();
  assert.deepEqual(await f.create().read([target]), original);
  assert.equal(f.requests.length, 2);
  f.recover();
  assert.deepEqual(await f.create().read([target]), original);
  assert.equal(f.requests.length, 2, "restart retains the failed-attempt backoff");
  f.advance(30 * 60_000);
  assert.equal((await f.create().read([target]))[0]!.version, "v2");
});

test("the alarm refreshes tracked prices daily without anyone opening the view", async () => {
  const f = fixture();
  await f.prices.read([target]);
  f.recover();
  await f.create().refresh();
  assert.equal(f.requests.length, 1);
  f.advance(86_400_000);
  await f.create().refresh();
  assert.equal(f.requests.length, 2);
  assert.equal((await f.prices.read([target]))[0]!.version, "v2");
});

test("a model appearing in the source is priced without a code change; existing prices survive changed target sets", async () => {
  const f = fixture();
  const future = { provider: "claude", model: "claude-future-77" };
  const original = await f.prices.read([target]);
  assert.deepEqual(await f.prices.read([future]), []);
  assert.deepEqual(await f.prices.read([target]), original);
  f.addModel();
  f.advance(30 * 60_000);
  await f.create().refresh();
  const prices = await f.create().read([target, future]);
  assert.equal(prices.length, 2);
  assert.equal(prices.find((price) => price.model === future.model)!.version, "new-model");
  assert.equal(prices.find((price) => price.model === target.model)!.version, "v1");
});

test("an unsupported context band or invalid snapshot retains the entire last-good model", async (t) => {
  t.mock.method(console, "error", () => {});
  const f = fixture();
  const original = await f.prices.read([target]);
  f.advance(86_400_000);
  f.invalid();
  assert.deepEqual(await f.prices.read([target]), original);
  const noHistory = fixture();
  noHistory.invalid();
  assert.deepEqual(await noHistory.prices.read([target]), []);
  const stale = fixture();
  stale.stale();
  assert.deepEqual(await stale.prices.read([target]), []);
});

test("concurrent reads share persisted rates instead of fetching the same source twice", async () => {
  const f = fixture();
  const prices = await Promise.all([f.prices.read([target]), f.prices.read([target])]);
  assert.equal(f.requests.length, 1);
  assert.deepEqual(prices[0], prices[1]);
});

test("a source outage without saved prices stays distinct from a confirmed missing public price", async (t) => {
  t.mock.method(console, "error", () => {});
  const f = fixture();
  f.fail();
  const failed = await f.prices.readTable([target]);
  assert.deepEqual(failed.prices, []);
  assert.match(failed.issues[0]!.reason, /refresh failed; no saved price for gpt-6.1-sol/);
  const missing = fixture();
  const unknown = { provider: "openai", model: "new-unpublished" };
  assert.deepEqual((await missing.prices.readTable([unknown])).issues, [
    { ...unknown, reason: "No public price for new-unpublished" },
  ]);
});

test("dated aliases are supplied to Home while exact target identities are preserved", async () => {
  const f = fixture();
  f.addModel();
  const dated = { provider: "claude", model: "anthropic/claude-opus-5.5-20261101" };
  const prices = await f.prices.read([dated]);
  assert.equal(prices[0]!.model, dated.model);
  assert.deepEqual(f.requests[0]!.targets, [dated]);
  assert.deepEqual(f.requests[0]!.policy, {
    overwrite_mode: "missing",
    default_multiplier: 1,
    include_zero_cost: true,
    aliases: [{ target_model: dated.model, source_models: ["claude-opus-5.5", "claude-opus-5-5"] }],
  });
});
