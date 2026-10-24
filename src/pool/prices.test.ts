import assert from "node:assert/strict";
import { test } from "node:test";
import { HomeClient } from "./control.ts";
import { PriceUpkeep } from "./prices.ts";

function fixture() {
  const values = new Map<string, unknown>();
  const calls: { path: string; body: Record<string, unknown> }[] = [];
  let fail = false;
  let conflict = false;
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
  return { calls, upkeep: new PriceUpkeep(home, storage), failing() { fail = true; }, conflict() { conflict = true; }, connect(model: string) { extra = [{ id: model, providers: ["claude"], billing_models: [{ provider: "claude", model }] }]; }, restart() { return new PriceUpkeep(home, storage); } };
}

test("Home imports exact execution identities with multiplier 1 and preserves manual rules", async (t) => {
  t.mock.method(console, "error", () => {});
  const f = fixture();
  await Promise.all([f.upkeep.run(1), f.upkeep.run(1)]);
  assert.deepEqual(f.calls[1]!.body, { source: "models.dev", targets: [{ provider: "codex", model: "gpt-example" }],
    policy: { overwrite_mode: "sync", default_multiplier: 1, include_zero_cost: true } });
  assert.deepEqual(f.calls[2]!.body, { preview_id: "preview", preview_revision: "rev", selected_keys: ["new", "sync"],
    confirm_overwrite: false, idempotency_key: "signalbox-prices-preview" });
  // Later alarms read which models exist every half hour until the day is over.
  await f.upkeep.run(2);
  assert.equal(f.calls.length, 3);
  await f.upkeep.run(1_800_002);
  assert.equal(f.calls.length, 4);
  await f.upkeep.run(86400001);
  assert.equal(f.calls.length, 7);
});

test("a newly available model is priced on the next alarm, not the next day", async (t) => {
  t.mock.method(console, "error", () => {});
  const f = fixture();
  await f.upkeep.run(1);
  f.connect("claude-example");
  await f.upkeep.run(1_800_002);
  assert.equal(f.calls.length, 6);
  assert.deepEqual(f.calls[4]!.body.targets, [{ provider: "codex", model: "gpt-example" }, { provider: "claude", model: "claude-example" }]);
});

test("an unreachable Home logs and reads the model list again half an hour later", async (t) => {
  const log = t.mock.method(console, "error", () => {});
  const f = fixture(); f.failing();
  await f.upkeep.run(1);
  assert.equal(log.mock.callCount(), 1);
  await f.upkeep.run(1_800_002);
  assert.deepEqual(f.calls.map((call) => call.path), ["/v8/management/models?scope=available", "/v8/management/models?scope=available"]);
});


test("concurrent price edits fail closed and the daily attempt survives a DO restart", async (t) => {
  t.mock.method(console, "error", () => {});
  const f = fixture(); f.conflict();
  await f.upkeep.run(1);
  assert.equal(f.calls.length, 3);
  await f.restart().run(2);
  assert.equal(f.calls.length, 4);
  await f.restart().run(86400001);
  assert.equal(f.calls.length, 7);
  assert.deepEqual(f.calls[2]!.body.selected_keys, ["new", "sync"]);
});
