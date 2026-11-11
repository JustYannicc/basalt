import assert from "node:assert/strict";
import { test } from "node:test";
import { releaseWorkers, type BarrierReceipt, type VersionProvider } from "./barrier.ts";
import { type ReleaseManifest } from "./manifest.ts";

const manifest = (): ReleaseManifest => ({
  candidate: "a".repeat(40),
  stack: "basalt",
  stage: "production",
  workers: ["Dashboard", "Api", "Router"].map((id) => ({
    id,
    accountId: "fixture",
    scriptName: id,
    metadata: {
      mainModule: "main.js",
      bindings: [{ name: "PRIVATE", type: "secret_text", text: "private-value" }],
    },
    files: [
      {
        name: "main.js",
        type: "application/javascript+module",
        bytes: new TextEncoder().encode(`export default ${JSON.stringify(id)}`),
      },
    ],
    baseline: [{ versionId: `old-${id}`, percentage: 100 }],
  })),
});

function fixture(overrides: Partial<VersionProvider> = {}) {
  const events: string[] = [];
  const receipts: BarrierReceipt[] = [];
  const provider: VersionProvider = {
    async upload(worker) {
      events.push(`upload:${worker.id}`);
      return { versionId: `new-${worker.id}`, startupTimeMs: 125 };
    },
    async baseline(worker) {
      events.push(`baseline:${worker.id}`);
      return worker.baseline;
    },
    async activate(worker, id) {
      events.push(`activate:${worker.id}:${id}`);
    },
    ...overrides,
  };
  return {
    events,
    receipts,
    options: {
      provider,
      async record(receipt: BarrierReceipt) {
        receipts.push(receipt);
      },
    },
  };
}

test("every Worker upload and baseline check precedes the first exact-ID activation", async () => {
  const proof = fixture();
  const result = await releaseWorkers(manifest(), proof.options);
  assert.deepEqual(proof.events, [
    "upload:Dashboard",
    "upload:Api",
    "upload:Router",
    "baseline:Dashboard",
    "baseline:Api",
    "baseline:Router",
    "activate:Dashboard:new-Dashboard",
    "activate:Api:new-Api",
    "activate:Router:new-Router",
  ]);
  assert.equal(result.phase, "complete");
  assert.equal(result.activated.length, 3);
  assert.ok(!JSON.stringify(proof.receipts).includes("private-value"));
});

test("a late rejected upload leaves every Worker on its previous version", async () => {
  const active = new Map(["Dashboard", "Api", "Router"].map((id) => [id, `old-${id}`]));
  const proof = fixture({
    async upload(worker) {
      if (worker.id === "Router") throw new Error("private provider payload");
      return { versionId: `new-${worker.id}`, startupTimeMs: 70 };
    },
    async activate(worker, id) {
      active.set(worker.id, id);
    },
  });
  await assert.rejects(releaseWorkers(manifest(), proof.options), /upload-rejected-or-unconfirmed/);
  assert.deepEqual([...active.values()], ["old-Dashboard", "old-Api", "old-Router"]);
  assert.deepEqual(proof.receipts.at(-1)?.activated, []);
  assert.equal(proof.receipts.at(-1)?.accepted.length, 2);
  assert.deepEqual(proof.receipts.at(-1)?.pendingUpload, { worker: "Router" });
  assert.ok(!JSON.stringify(proof.receipts).includes("private provider payload"));
});

for (const startup of [undefined, null, -1, Number.NaN, Number.POSITIVE_INFINITY, 750.1]) {
  test(`unproved or over-ceiling startup ${String(startup)} never activates`, async () => {
    let uploads = 0;
    const proof = fixture({
      async upload() {
        uploads++;
        return { versionId: "version", startupTimeMs: startup };
      },
    });
    await assert.rejects(releaseWorkers(manifest(), proof.options));
    assert.deepEqual(proof.receipts.at(-1)?.activated, []);
    assert.equal(proof.events.length, 0);
    assert.equal(uploads, startup === 750.1 ? 2 : 1);
    assert.equal(proof.receipts.at(-1)?.pendingUpload?.versionId, "version");
    if (typeof startup === "number" && Number.isFinite(startup))
      assert.equal(proof.receipts.at(-1)?.pendingUpload?.startupTimeMs, startup);
  });
}

test("missing version ID refuses activation even with good startup evidence", async () => {
  const proof = fixture({
    async upload() {
      return { startupTimeMs: 20 };
    },
  });
  await assert.rejects(releaseWorkers(manifest(), proof.options), /missing-version-id/);
  assert.deepEqual(proof.receipts.at(-1)?.activated, []);
});

test("one noisy startup measurement reuploads the frozen Worker before any activation", async () => {
  const uploads: string[] = [];
  const proof = fixture({
    async upload(worker) {
      uploads.push(worker.id);
      return {
        versionId: `version-${uploads.length}`,
        startupTimeMs: uploads.length === 1 ? 770 : 303,
      };
    },
  });
  const result = await releaseWorkers(manifest(), proof.options);
  assert.deepEqual(uploads, ["Dashboard", "Dashboard", "Api", "Router"]);
  assert.deepEqual(result.startupMeasurements?.slice(0, 2), [
    { worker: "Dashboard", versionId: "version-1", startupTimeMs: 770 },
    { worker: "Dashboard", versionId: "version-2", startupTimeMs: 303 },
  ]);
  assert.deepEqual(result.accepted[0], {
    worker: "Dashboard",
    versionId: "version-2",
    startupTimeMs: 303,
  });
  assert.equal(proof.events[0], "baseline:Dashboard");
  assert.deepEqual(result.activated[0], { worker: "Dashboard", versionId: "version-2" });
  assert.ok(
    proof.receipts.some(
      (receipt) => receipt.startupMeasurements?.length === 1 && receipt.activated.length === 0,
    ),
  );
});

test("two over-ceiling startup measurements refuse without a third upload or activation", async () => {
  let uploads = 0;
  const proof = fixture({
    async upload() {
      uploads++;
      return { versionId: `version-${uploads}`, startupTimeMs: uploads === 1 ? 770 : 780 };
    },
  });
  await assert.rejects(releaseWorkers(manifest(), proof.options), /startup-headroom/);
  assert.equal(uploads, 2);
  assert.deepEqual(proof.events, []);
  assert.deepEqual(proof.receipts.at(-1)?.startupMeasurements, [
    { worker: "Dashboard", versionId: "version-1", startupTimeMs: 770 },
    { worker: "Dashboard", versionId: "version-2", startupTimeMs: 780 },
  ]);
});

test("an unconfirmed second upload preserves the first measurement and never retries again", async () => {
  let uploads = 0;
  const proof = fixture({
    async upload() {
      uploads++;
      if (uploads === 2) throw new Error("private provider payload");
      return { versionId: "version-1", startupTimeMs: 770 };
    },
  });
  await assert.rejects(releaseWorkers(manifest(), proof.options), /upload-rejected-or-unconfirmed/);
  assert.equal(uploads, 2);
  assert.deepEqual(proof.events, []);
  assert.deepEqual(proof.receipts.at(-1)?.startupMeasurements, [
    { worker: "Dashboard", versionId: "version-1", startupTimeMs: 770 },
  ]);
  assert.deepEqual(proof.receipts.at(-1)?.pendingUpload, { worker: "Dashboard" });
});

test("a changed manifest refuses before the remeasurement upload", async () => {
  const input = manifest();
  let uploads = 0;
  const proof = fixture({
    async upload() {
      uploads++;
      input.workers[0]!.files[0]!.bytes[0] = 0;
      return { versionId: "version-1", startupTimeMs: 770 };
    },
  });
  await assert.rejects(releaseWorkers(input, proof.options), /manifest-drift/);
  assert.equal(uploads, 1);
  assert.deepEqual(proof.events, []);
});

test("manifest mutation while uploading is detected before activation", async () => {
  const input = manifest();
  const proof = fixture({
    async upload() {
      input.workers[0]!.files[0]!.bytes[0] = 0;
      return { versionId: "version", startupTimeMs: 20 };
    },
  });
  await assert.rejects(releaseWorkers(input, proof.options), /manifest-drift/);
  assert.deepEqual(proof.receipts.at(-1)?.activated, []);
});

test("a changed live deployment refuses the complete admitted batch", async () => {
  const proof = fixture({
    async baseline() {
      return [{ versionId: "someone-else", percentage: 100 }];
    },
  });
  await assert.rejects(releaseWorkers(manifest(), proof.options), /deployment-drift/);
  assert.deepEqual(proof.receipts.at(-1)?.activated, []);
});

test("database work starts after acceptance and its failure prevents all activation", async () => {
  const proof = fixture();
  await assert.rejects(
    releaseWorkers(manifest(), {
      ...proof.options,
      async beforeActivate() {
        assert.equal(proof.receipts.at(-1)?.accepted.length, 3);
        throw new Error("database phase failure");
      },
    }),
    /barrier-operation-failed/,
  );
  assert.deepEqual(proof.receipts.at(-1)?.activated, []);
});

test("an uncertain activation retains the completed IDs and pending intent", async () => {
  const proof = fixture({
    async activate(worker) {
      if (worker.id === "Api") throw new Error("lost response");
    },
  });
  await assert.rejects(releaseWorkers(manifest(), proof.options), /activation-unconfirmed/);
  const receipt = proof.receipts.at(-1)!;
  assert.deepEqual(receipt.activated, [{ worker: "Dashboard", versionId: "new-Dashboard" }]);
  assert.deepEqual(receipt.pending, { worker: "Api", versionId: "new-Api" });
  assert.equal(receipt.failure?.reason, "activation-unconfirmed");
});
