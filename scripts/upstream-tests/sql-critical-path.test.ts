import assert from "node:assert/strict";
import { test } from "node:test";
import { sqlCriticalPath } from "../../.upstream/e2e/support/sql-critical-path.ts";

const wire = (start: number, durationMs: number) => ({
  span: {
    operationName: "sql.wire",
    startTime: new Date(start).toISOString(),
    durationMs,
    tags: { "db.wire.clock": "date-now" },
  },
});

test("parallel wire requests count as one sequential round trip", () => {
  assert.deepEqual(sqlCriticalPath([wire(0, 8), wire(0, 8), wire(8, 8)]), {
    wireRequests: 3,
    sequentialRoundTrips: 2,
    sqlMillisAt8ms: 16,
  });
});

test("overlap never hides a longer sequential chain, even when an independent request spans it", () => {
  assert.equal(
    sqlCriticalPath([wire(0, 40), wire(0, 8), wire(8, 8), wire(16, 8), wire(24, 8)])
      .sequentialRoundTrips,
    4,
  );
  assert.equal(sqlCriticalPath([wire(0, 0), wire(0, 0), wire(0, 8)]).sequentialRoundTrips, 3);
});

test("a missing or incompatible wire clock refuses the proof", () => {
  assert.throws(() => sqlCriticalPath([]), /no wire requests/);
  const unknown = wire(0, 8);
  unknown.span.tags["db.wire.clock"] = "unknown";
  assert.throws(() => sqlCriticalPath([unknown]), /shared host clock/);
});
