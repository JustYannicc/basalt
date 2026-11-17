import assert from "node:assert/strict";
import { test } from "node:test";
import { releaseWorkers, type BarrierReceipt } from "./barrier.ts";
import { manifestDigest, type ReleaseManifest } from "./manifest.ts";
import { readySqlSchemas } from "./sql-schema-fixture.ts";

const manifest = (): ReleaseManifest => ({
  candidate: "a".repeat(40),
  stack: "basalt",
  stage: "production",
  workers: [
    {
      id: "McpServer",
      accountId: "synthetic-account",
      scriptName: "synthetic-mcp",
      metadata: { mainModule: "main.js" },
      files: [
        {
          name: "main.js",
          type: "application/javascript+module",
          bytes: new TextEncoder().encode("export default {fetch(){return new Response('ok')}}"),
        },
      ],
      baseline: [{ versionId: "baseline", percentage: 100 }],
    },
  ],
});

for (const readings of [
  [900, 284, 284],
  [284, 900, 284],
  [284, 284, 900],
])
  test(`one noisy startup reading ${readings.join("/")} keeps the frozen version admissible`, async () => {
    const input = manifest();
    const fingerprint = manifestDigest(input);
    const receipts: BarrierReceipt[] = [];
    const activated: string[] = [];
    let uploads = 0;
    const result = await releaseWorkers(input, {
      provider: {
        async upload(worker) {
          assert.equal(manifestDigest(input), fingerprint);
          assert.deepEqual(worker.files, input.workers[0]!.files);
          return { versionId: `sample-${uploads}`, startupTimeMs: readings[uploads++] };
        },
        async baseline() {
          return input.workers[0]!.baseline;
        },
        async activate(_worker, id) {
          activated.push(id);
        },
      },
      record: async (receipt) => {
        receipts.push(receipt);
      },
      sqlSchemas: async () => readySqlSchemas(input.candidate),
    });
    assert.equal(result.phase, "complete");
    assert.ok(uploads >= 2 && uploads <= 3);
    assert.equal(result.startupMeasurements?.filter((row) => row.startupTimeMs <= 750).length, 2);
    assert.equal(result.accepted[0]?.startupTimeMs, 284);
    assert.deepEqual(activated, [result.accepted[0]!.versionId]);
    assert.equal(
      receipts.find((receipt) => receipt.activated.length)?.startupMeasurements?.length,
      uploads,
    );
  });

for (const readings of [
  [284, 900, 900],
  [900, 284, 900],
  [900, 900, 284],
])
  test(`real startup growth ${readings.join("/")} refuses before activation`, async () => {
    const input = manifest();
    const activated: string[] = [];
    let uploads = 0;
    await assert.rejects(
      releaseWorkers(input, {
        provider: {
          async upload() {
            return { versionId: `sample-${uploads}`, startupTimeMs: readings[uploads++] };
          },
          async baseline() {
            return input.workers[0]!.baseline;
          },
          async activate(_worker, id) {
            activated.push(id);
          },
        },
        record: async () => {},
        sqlSchemas: async () => readySqlSchemas(input.candidate),
      }),
      /startup-headroom/,
    );
    assert.ok(uploads >= 2 && uploads <= 3);
    assert.deepEqual(activated, []);
  });
