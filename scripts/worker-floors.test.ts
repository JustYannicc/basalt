import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { checkFloors, floorOf, readUploads, uploadFloors } from "./worker-floors.ts";

const upload = (worker: string, bytes: number, budget: number) => ({ worker, bytes, budget });
const base = (...uploads: ReturnType<typeof upload>[]) =>
  new Map(uploads.map((entry) => [entry.worker, entry]));

test("each Worker's levels are its shares of its own budget, warn above fail", () => {
  assert.deepEqual(floorOf(upload("dashboard", 0, 3_900_000)), { warn: 585_000, fail: 390_000 });
  assert.deepEqual(floorOf(upload("app-pages", 0, 2_500_000)), { warn: 100_000, fail: 75_000 });
  assert.deepEqual(floorOf(upload("app-data", 0, 700_000)), { warn: 35_000, fail: 21_000 });
  // A budget an upstream sync changes moves the levels with it.
  assert.deepEqual(floorOf(upload("dashboard", 0, 4_500_000)), { warn: 675_000, fail: 450_000 });
  for (const worker of [...Object.keys(uploadFloors), "any-other"]) {
    const floor = floorOf(upload(worker, 0, 1_000_000));
    assert.ok(floor.warn > floor.fail && floor.fail > 0, worker);
  }
});

test("a Worker below its fail level fails with the bytes the change added", () => {
  const [finding, ...rest] = checkFloors(
    [upload("dashboard", 3_510_001, 3_900_000)],
    base(upload("dashboard", 3_074_648, 3_900_000)),
  );
  assert.equal(rest.length, 0);
  assert.equal(finding!.level, "error");
  assert.equal(finding!.worker, "dashboard");
  assert.match(finding!.message, /leaves 389,999 bytes of its 3,900,000-byte upload budget/);
  assert.match(finding!.message, /below its 390,000-byte fail level/);
  assert.match(
    finding!.message,
    /This change added 435,353 bytes compared with the base \(3,074,648 to 3,510,001\)/,
  );
});

test("between the two levels a Worker warns with the bytes added and passes", () => {
  for (const bytes of [2_400_001, 2_425_000]) {
    const [finding, ...rest] = checkFloors(
      [upload("app-pages", bytes, 2_500_000)],
      base(upload("app-pages", 2_395_545, 2_500_000)),
    );
    assert.equal(rest.length, 0);
    assert.equal(finding!.level, "warning");
    assert.match(finding!.message, /below its 100,000-byte warn level; it fails below 75,000/);
    assert.match(
      finding!.message,
      new RegExp(`This change added ${(bytes - 2_395_545).toLocaleString("en-US")} bytes`),
    );
  }
});

test("at or above its warn level a Worker is silent", () => {
  assert.deepEqual(
    checkFloors(
      [
        upload("dashboard", 3_315_000, 3_900_000),
        upload("app-pages", 2_400_000, 2_500_000),
        upload("api", 5_119_032, 5_460_000),
      ],
      base(),
    ),
    [],
  );
});

test("an unknown base still fails a Worker below its fail level and says the growth is unknown", () => {
  const [finding] = checkFloors([upload("app-pages", 2_430_000, 2_500_000)], undefined);
  assert.equal(finding!.level, "error");
  assert.match(finding!.message, /below its 75,000-byte fail level/);
  assert.match(finding!.message, /base's upload sizes were not available/);
});

test("a Worker new since the base counts every byte as added", () => {
  const [finding] = checkFloors([upload("edge", 390_000, 400_000)], base());
  assert.equal(finding!.level, "error");
  assert.match(finding!.message, /This change added 390,000 bytes compared with the base \(0 to/);
});

test("a change that adds nothing to a Worker already below its fail level only warns", () => {
  const [shrunk] = checkFloors(
    [upload("app-pages", 2_440_000, 2_500_000)],
    base(upload("app-pages", 2_441_000, 2_500_000)),
  );
  assert.equal(shrunk!.level, "warning");
  assert.match(shrunk!.message, /This change added -1,000 bytes/);
  assert.match(shrunk!.message, /did not grow the Worker, so it does not fail/);
  const [unchanged] = checkFloors(
    [upload("app-pages", 2_441_000, 2_500_000)],
    base(upload("app-pages", 2_441_000, 2_500_000)),
  );
  assert.equal(unchanged!.level, "warning");
});

test("upload records are read by Worker, and a missing base directory is unknown", () => {
  const directory = mkdtempSync(join(tmpdir(), "basalt-worker-floors-"));
  try {
    assert.equal(readUploads(join(directory, "missing")), undefined);
    mkdirSync(join(directory, "uploads"));
    writeFileSync(
      join(directory, "uploads", "dashboard.json"),
      JSON.stringify({ ...upload("dashboard", 1, 2), sources: { "a.ts": 1 } }),
    );
    writeFileSync(join(directory, "uploads", "notes.txt"), "ignored");
    assert.deepEqual(readUploads(join(directory, "uploads")), base(upload("dashboard", 1, 2)));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
