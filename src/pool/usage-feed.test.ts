import assert from "node:assert/strict";
import { test } from "node:test";
import { readUsagePage, type UsageScan } from "./usage-feed.ts";
import type { Json } from "./json.ts";

test("narrow feed restarts a legacy offset once and preserves source cursor precision", async () => {
  const scan: UsageScan = {
    from: Date.parse("2026-11-12T00:00:00Z"),
    to: Date.parse("2026-11-13T00:00:00Z"),
    offset: 900,
  };
  const timestamp = "2026-11-12T12:00:00.123456Z";
  const paths: URL[] = [];
  const home = {
    data: async (path: string): Promise<Json> => {
      paths.push(new URL(path, "https://fixture.invalid"));
      return paths.length === 1
        ? {
            items: [{ timestamp, id: "123456789012345678" }],
            next: { timestamp, id: "123456789012345678" },
          }
        : { items: [{ timestamp, id: "123456789012345679" }], next: null };
    },
  };
  assert.equal((await readUsagePage(home, scan, true)).complete, false);
  assert.equal(scan.offset, 1);
  const restored = structuredClone(scan);
  assert.equal((await readUsagePage(home, restored, true)).complete, true);
  assert.equal(restored.offset, 2);
  assert.equal(paths[0]!.pathname, "/usage/summary-records");
  for (const path of paths) assert.equal(path.searchParams.has("offset"), false);
  assert.equal(paths[1]!.searchParams.get("after_timestamp"), timestamp);
  assert.equal(paths[1]!.searchParams.get("after_id"), "123456789012345678");
});

test("malformed or stationary cursors fail without marking a page complete", async () => {
  for (const page of [
    { items: [], next: {} },
    { items: [{ timestamp: "2026-11-12T12:00:00Z", id: "1" }] },
    {
      items: [{ timestamp: "2026-11-12T12:00:00Z", id: "1" }],
      next: { timestamp: "2026-11-12T12:00:00Z", id: "2" },
    },
  ]) {
    const scan = { from: 0, to: Date.now(), offset: 0 };
    await assert.rejects(readUsagePage({ data: async () => page }, scan, true));
  }
});

test("rolling back to an older Home restarts safely through receipts", async () => {
  const scan: UsageScan = {
    from: 0,
    to: 1000,
    offset: 10,
    keyset: true,
    after: { timestamp: "1970-01-01T00:00:00.000001Z", id: "7" },
  };
  const home = {
    data: async (path: string) => {
      const query = new URL(path, "https://fixture.invalid");
      assert.equal(query.pathname, "/usage/records");
      assert.equal(query.searchParams.get("offset"), "0");
      assert.equal(query.searchParams.has("after_id"), false);
      return { items: [], total: 0 };
    },
  };
  assert.equal((await readUsagePage(home, scan, false)).complete, true);
  assert.equal(scan.after, undefined);
});
