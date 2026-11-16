import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { canonical, digest } from "../release-barrier/manifest.ts";
import { fixture } from "./recorded-recovery-fixture.ts";
import { runRecordedRecovery } from "./recorded-recovery.ts";

test("a named failed release restores the half-activated fixture to its exact recorded Worker versions", async (context) => {
  const f = fixture(context);
  f.zip();
  await runRecordedRecovery(f.request, f.io);
  assert.deepEqual(f.restored, ["Router", "Api"]);
  assert.deepEqual(
    [...f.active.values()],
    f.workers.map((worker) => worker.baseline),
  );
});

test("a different manifest/receipt pair refuses before candidate preparation or a recovery write", async (context) => {
  const f = fixture(context);
  f.zip();
  await assert.rejects(
    runRecordedRecovery({ ...f.request, pairSha256: "0".repeat(64) }, f.io),
    /pair.*differs/,
  );
  assert.deepEqual(f.prepared, []);
  assert.deepEqual(f.restored, []);
});

test("a manifest without its recorded receipt refuses before candidate preparation", async (context) => {
  const f = fixture(context);
  f.zip(false);
  f.request.pairSha256 = digest(canonical({ manifest: f.manifest, receipt: null }));
  await assert.rejects(runRecordedRecovery(f.request, f.io), /receipt/);
  assert.deepEqual(f.prepared, []);
  assert.deepEqual(f.restored, []);
});

for (const [name, change] of [
  [
    "another ledger run",
    (f) => {
      f.payload.run.id = 99;
    },
  ],
  [
    "a successful production deployment",
    (f) => {
      f.status.current = "success";
    },
  ],
  [
    "an unfinished source run",
    (f) => {
      f.run.status = "in_progress";
    },
  ],
  [
    "a newer source attempt",
    (f) => {
      f.run.run_attempt = 2;
    },
  ],
  [
    "a source outside main",
    (f) => {
      f.run.head_branch = "feature";
    },
  ],
  [
    "a different workflow",
    (f) => {
      f.run.path = ".github/workflows/release-preview.yml";
    },
  ],
  [
    "a foreign repository",
    (f) => {
      f.run.head_repository.full_name = "foreign/repo";
    },
  ],
] satisfies Array<[string, (f: ReturnType<typeof fixture>) => void]>)
  test(`recorded recovery refuses ${name} before preparing candidate code`, async (context) => {
    const f = fixture(context);
    f.zip();
    change(f);
    await assert.rejects(runRecordedRecovery(f.request, f.io), /Recovery source/);
    assert.deepEqual(f.prepared, []);
    assert.deepEqual(f.restored, []);
  });

test("production advancing during candidate preparation stops recovery before its first write", async (context) => {
  const f = fixture(context);
  f.zip();
  const prepare = f.io.prepare;
  f.io.prepare = async (release) => {
    const root = await prepare(release);
    f.status.current = "success";
    return root;
  };
  await assert.rejects(runRecordedRecovery(f.request, f.io), /Recovery source/);
  assert.deepEqual(f.restored, []);
});

test("the exact receipt is checked again after candidate preparation", async (context) => {
  const f = fixture(context);
  f.zip();
  const prepare = f.io.prepare;
  f.io.prepare = async (release) => {
    const root = await prepare(release);
    writeFileSync(
      join(f.io.directory, "receipt.json"),
      JSON.stringify({ ...f.receipt, activated: [] }),
    );
    return root;
  };
  await assert.rejects(runRecordedRecovery(f.request, f.io), /Recovery.*evidence.*changed/);
  assert.deepEqual(f.restored, []);
});

test("an explicit continuation preserves the prior matching recovery progress beside the original pair", async (context) => {
  const f = fixture(context);
  f.zip();
  f.progressZip();
  f.active.set("Api", f.workers[0]!.baseline);
  const execute = f.io.execute;
  f.io.execute = async (...args) => {
    assert.deepEqual(
      JSON.parse(readFileSync(join(f.io.directory, "recovery.json"), "utf8")),
      f.progress,
    );
    await execute(...args);
  };
  await runRecordedRecovery({ ...f.request, progressRun: "43/1" }, f.io);
  assert.deepEqual(f.restored, ["Router"]);
});

test("a continuation from another release refuses without writing a Worker", async (context) => {
  const f = fixture(context);
  f.zip();
  f.progressZip("99/1");
  await assert.rejects(
    runRecordedRecovery({ ...f.request, progressRun: "43/1" }, f.io),
    /Recovery progress/,
  );
  assert.deepEqual(f.prepared, []);
  assert.deepEqual(f.restored, []);
});
