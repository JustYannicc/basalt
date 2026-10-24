import assert from "node:assert/strict";
import { test } from "node:test";
import { HomeClient } from "./control.ts";
import { PriceUpkeep } from "./prices.ts";

function fixture() {
  const values = new Map<string, unknown>();
  const calls: { path: string; body: Record<string, unknown> }[] = [];
  let fail = false;
  let conflict = false;
  const manualRules: { provider: string; model: string; source: string }[] = [];
  let extra: { id: string; providers: string[]; billing_models: { provider: string; model: string }[] }[] = [];
  const home = new HomeClient(async (path, init) => {
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    calls.push({ path, body });
    if (fail) return Response.json({ error: "unavailable" }, { status: 502 });
    if (path.endsWith("/models?scope=available")) return Response.json({ models: [
      { id: "alias", providers: ["codex"], billing_models: [{ provider: "codex", model: "gpt-example" }] },
      { id: "must-not-guess", providers: ["claude"], billing_models: [] },
      { id: "unsupported", providers: ["unknown"] },
      ...extra,
    ] });
    if (path.endsWith("/billing/model-prices")) return Response.json({ price_rule_schema_version: 2, items: manualRules });
    if (conflict && path.endsWith("/apply")) return Response.json({ error: "model_price_revision_conflict" }, { status: 409 });
    if (path.endsWith("/preview")) return Response.json({ preview_id: "preview", preview_revision: "rev", atomic: true, rows: [
      { row_key: "new", applicable: true, action: "create" },
      { row_key: "sync", applicable: true, action: "update_sync", existing_rule: { source: "sync" } },
      { row_key: "manual", applicable: true, action: "overwrite", existing_rule: { source: "manual" } },
      { row_key: "bad-sync", applicable: true, action: "update_sync", existing_rule: { source: "manual" } },
      { row_key: "unmatched", applicable: false, action: "review" },
    ] });
    return Response.json({ status: "applied", atomic: true });
  });
  const storage = { async get<T>(key: string) { return values.get(key) as T | undefined; }, async put(key: string, value: unknown) { values.set(key, value); } };
  const count = (suffix: string) => calls.filter((call) => call.path.endsWith(suffix)).length;
  const body = (suffix: string) => calls.find((call) => call.path.endsWith(suffix))!.body;
  return { calls, count, body, upkeep: new PriceUpkeep(home, storage), failing() { fail = true; }, conflict() { conflict = true; }, priceByHand(provider: string, model: string) { manualRules.push({ provider, model, source: "manual" }); }, connect(model: string) { extra = [{ id: model, providers: ["claude"], billing_models: [{ provider: "claude", model }] }]; }, restart() { return new PriceUpkeep(home, storage); } };
}

test("Home imports exact execution identities with multiplier 1 and preserves manual rules", async (t) => {
  t.mock.method(console, "error", () => {});
  const f = fixture();
  await Promise.all([f.upkeep.run(1), f.upkeep.run(1)]);
  assert.deepEqual(f.body("/preview"), { source: "models.dev", targets: [{ provider: "codex", model: "gpt-example" }],
    policy: { overwrite_mode: "sync", default_multiplier: 1, include_zero_cost: true } });
  assert.deepEqual(f.body("/apply"), { preview_id: "preview", preview_revision: "rev", selected_keys: ["new", "sync"],
    confirm_overwrite: false, idempotency_key: "signalbox-prices-preview" });
  // Later alarms read which models exist every half hour until the day is over.
  await f.upkeep.run(2);
  assert.equal(f.count("/models?scope=available"), 1);
  await f.upkeep.run(1_800_002);
  assert.deepEqual([f.count("/models?scope=available"), f.count("/preview")], [2, 1]);
  await f.upkeep.run(86400001);
  assert.deepEqual([f.count("/models?scope=available"), f.count("/preview"), f.count("/apply")], [3, 2, 2]);
});

test("a model priced by hand is never imported, so no synced band can outrank it", async (t) => {
  t.mock.method(console, "error", () => {});
  const f = fixture();
  f.connect("claude-example");
  f.priceByHand("claude", "claude-example");
  await f.upkeep.run(1);
  assert.deepEqual(f.body("/preview").targets, [{ provider: "codex", model: "gpt-example" }]);
});

test("a newly available model is priced on the next check, not the next day", async (t) => {
  t.mock.method(console, "error", () => {});
  const f = fixture();
  await f.upkeep.run(1);
  f.connect("claude-example");
  await f.upkeep.run(1_800_002);
  assert.equal(f.count("/preview"), 2);
  assert.deepEqual(f.calls.filter((call) => call.path.endsWith("/preview"))[1]!.body.targets,
    [{ provider: "codex", model: "gpt-example" }, { provider: "claude", model: "claude-example" }]);
});

test("an unreachable Home logs and reads the model list again half an hour later", async (t) => {
  const log = t.mock.method(console, "error", () => {});
  const f = fixture(); f.failing();
  await f.upkeep.run(1);
  assert.equal(log.mock.callCount(), 1);
  await f.upkeep.run(100);
  await f.upkeep.run(1_800_002);
  assert.deepEqual(f.calls.map((call) => call.path), ["/v8/management/models?scope=available", "/v8/management/models?scope=available"]);
});

test("concurrent price edits fail closed and the daily attempt survives a DO restart", async (t) => {
  t.mock.method(console, "error", () => {});
  const f = fixture(); f.conflict();
  await f.upkeep.run(1);
  assert.equal(f.count("/apply"), 1);
  await f.restart().run(2);
  assert.equal(f.count("/apply"), 1);
  await f.restart().run(86400001);
  assert.equal(f.count("/apply"), 2);
  assert.deepEqual(f.body("/apply").selected_keys, ["new", "sync"]);
});
