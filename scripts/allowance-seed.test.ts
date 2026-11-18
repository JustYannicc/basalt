import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { renewSeed } from "./allowance-seed.ts";

const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");
const committed = JSON.parse(read("../src/pool/allowances/seed.json"));
const vendor: Record<string, string> = JSON.parse(
  read("../src/pool/allowances/fixtures/vendor-sources.json"),
);
const now = Date.parse("2026-11-20T00:00:00Z");

/** Current public sources that re-checked everything the day before. */
function sources(checked: string): typeof fetch {
  const dataset = JSON.parse(read("../src/pool/allowances/fixtures/plan-yield.json"));
  dataset.as_of = checked;
  for (const row of dataset.options) {
    row.checked = checked;
    if (row.status_class === "stale") row.status_class = "warn";
  }
  return async (input) => {
    const url = String(input);
    if (url.includes("planyield")) return Response.json(dataset);
    if (url.includes("max-plan")) return new Response(vendor["claude-max"]);
    if (url.includes("ultra-plan")) return new Response(vendor["claude-ultra"]);
    return new Response(null, { status: 503 });
  };
}

test("a seed row inside the renewal lead fails while a source runs later, and renewal clears it", async () => {
  const before = await renewSeed(committed, { now, fetch: sources("2026-11-19") });
  assert.ok(before.overdue.length > 0);
  assert.ok(before.overdue.some((row) => row.key === "anthropic/pro/604800s (dataset)"));
  for (const row of before.overdue) assert.ok(row.renewedExpiresAt! > row.expiresAt);
  const after = await renewSeed(before.seed, { now, fetch: sources("2026-11-19") });
  assert.deepEqual(after.overdue, []);
  for (const row of after.stale)
    assert.ok(row.renewedExpiresAt === null || row.renewedExpiresAt <= row.expiresAt);
});

test("offline, every row stays and stale rows are named warnings, never a failure", async () => {
  const unavailable: typeof fetch = async () => new Response(null, { status: 503 });
  const result = await renewSeed(committed, { now, fetch: unavailable });
  assert.deepEqual(result.overdue, []);
  assert.ok(result.stale.some((row) => row.key.startsWith("anthropic/max_20x/604800s")));
  assert.equal(result.seed, committed);
});

test("a source that answers but no longer parses keeps its committed rows", async () => {
  const broken: typeof fetch = async (input) =>
    String(input).includes("planyield")
      ? new Response("<html>challenge</html>", { status: 200 })
      : new Response(null, { status: 503 });
  const result = await renewSeed(committed, { now, fetch: broken });
  const dataset = (entries: { sourceId?: string }[]) =>
    entries.filter((entry) => entry.sourceId === "dataset").length;
  assert.equal(dataset(result.seed.entries), dataset(committed.entries));
  assert.deepEqual(result.overdue, []);
});
