import assert from "node:assert/strict";
import { test } from "node:test";
import type { AccountsNeeded, DayUsage, ModelUsage } from "../contract.ts";
import { advice, columns, cost, dayRange, series, tokens } from "./usage-format.ts";

const slice = (total: number, spend: number) => ({
  requests: 1, tokens: { input: total, cacheRead: 0, cacheWrite: 0, output: 0, total }, cost: spend, unpriced: 0,
});
const model = (name: string, total: number, spend: number): ModelUsage => ({ provider: "claude", model: name, ...slice(total, spend) });

test("formats tokens and API-equivalent cost without hiding tiny spend", () => {
  assert.equal(tokens(12_400_000), "12.4M");
  assert.equal(tokens(-5), "0");
  assert.equal(cost(0), "$0.00");
  assert.equal(cost(0.004), "<$0.01");
  assert.equal(cost(0.42), "$0.42");
  assert.equal(cost(84.2), "$84.20");
});

test("keeps empty days in the chart range", () => {
  assert.deepEqual(dayRange("2026-10-01T10:00:00.000Z", "2026-10-04T09:00:00.000Z"), ["2026-10-01", "2026-10-02", "2026-10-03", "2026-10-04"]);
  assert.deepEqual(dayRange("nope", "2026-10-04T00:00:00.000Z"), []);
});

test("the same model name through two providers stays two series", () => {
  const twice = [model("a", 50, 5), { ...model("a", 30, 3), provider: "other" }];
  assert.deepEqual(series(twice, "tokens").keys, ["claude:a", "other:a"]);
});

test("folds smaller models into Other so a column still adds up", () => {
  const models = [model("a", 50, 5), model("b", 30, 3), model("c", 20, 2)];
  assert.deepEqual(series(models, "tokens", 2), { keys: ["claude:a", "claude:b"], other: true });
  const day: DayUsage = { day: "2026-10-02", models, ...slice(100, 10) };
  const [empty, full] = columns([day], ["2026-10-01", "2026-10-02"], ["claude:a", "claude:b"], "cost");
  assert.deepEqual(empty, { day: "2026-10-01", total: 0, parts: [] });
  assert.equal(full!.total, 10);
  assert.deepEqual(full!.parts, [{ key: "claude:a", amount: 5 }, { key: "claude:b", amount: 3 }, { key: "", amount: 2 }]);
});

test("says plainly whether to add or remove an account", () => {
  const entry = (advice: AccountsNeeded["advice"], accounts = 2, limitHits = 0): AccountsNeeded =>
    ({ provider: "claude", advice, accounts, limitHits, exhausted: 0, hoursRead: 168 });
  assert.match(advice(entry("add", 2, 4), "Claude"), /^Add a Claude account\./);
  assert.match(advice(entry("remove", 3), "Claude"), /^You could remove a Claude account\./);
  assert.equal(advice(entry("remove", 1), "Claude"), "Claude has room to spare.");
  assert.match(advice(entry("enough", 2, 1), "Claude"), /hit a limit 1 time this week/);
  assert.match(advice(entry("unknown"), "Claude"), /Not enough readings yet/);
});
