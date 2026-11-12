import assert from "node:assert/strict";
import { test } from "node:test";
import { HomeClient, PoolHome } from "./control.ts";
import { fixture } from "./test/control.ts";

test("first success batches only current credentials and preserves fractional timestamp order", async () => {
  const f = await fixture();
  const accounts = Array.from({ length: 101 }, (_, index) => `account-${index}`);
  f.home.addGroup("pool-a", 10, accounts);
  const since = "2026-11-12T10:00:00Z";
  const batches: string[][] = [];
  f.home.override = (path) => {
    const url = new URL(path, "https://home.example");
    if (url.pathname.endsWith("/capabilities"))
      return Response.json({ capabilities: { usage_first_success_v1: true } });
    if (!url.pathname.endsWith("/usage/first-success")) return undefined;
    assert.equal(url.searchParams.get("client_key_id"), "123");
    assert.equal(url.searchParams.get("from"), since);
    batches.push(url.searchParams.getAll("credential_id"));
    return Response.json({
      timestamp: batches.length === 1 ? "2026-11-12T10:01:00.0009Z" : "2026-11-12T10:01:00.0001Z",
    });
  };
  const pool = new PoolHome(new HomeClient(f.home.fetch), "pool-a");
  assert.equal(await pool.firstSuccessfulUsage(123, since), "2026-11-12T10:01:00.0001Z");
  assert.deepEqual(
    batches.map((batch) => batch.length),
    [100, 1],
  );
  assert.deepEqual(batches.flat(), accounts);
  assert.equal(
    f.home.calls.some(({ path }) => path.includes("/usage/records")),
    false,
  );
});
