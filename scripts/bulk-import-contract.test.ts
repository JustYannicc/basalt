import assert from "node:assert/strict";
import { test } from "node:test";
import { Schema } from "effect";
import {
  PoolUsageBulkImportInput,
  PoolUsageBulkImportStatus,
} from "../.upstream/apps/hosted/server/src/contracts/pool-usage-bulk-import.ts";
import { bulkDefinition, type BulkGuard } from "../src/pool/model-history/bulk-contract.ts";
import { BulkJob } from "../src/pool/model-history/bulk-job.ts";
import { bulkStatus } from "./bulk-cli-protocol.ts";

const now = 1_800_000_000_000;
const identity = { pool: "fixture-pool", owner: "fixture-owner", organization: "fixture-org" };
const route = {
  route: "/v1/responses",
  streamMode: "stream" as const,
  successful: 100,
  failures: 0,
  serverErrors: 0,
  total: 100,
  p99Ms: 100,
};
const guard: BulkGuard = {
  observedAt: now,
  expiresAt: now + 90_000,
  cpuAt: now - 60_000,
  ready: true,
  cpu: 40,
  releaseReadComplete: true,
  releaseWindowActive: false,
  poolErrors: 0,
  queryErrors: 0,
  serving: {
    source: "fixture-completions",
    kind: "model-completion",
    available: true,
    observedAt: now,
    computedAt: now,
    baseline: { from: now - 600_000, to: now - 300_000, routes: [route], nonRelease: true },
    window: { from: now - 300_000, to: now, routes: [{ ...route, p99Ms: 120 }] },
  },
};

async function fixture() {
  const definition = await bulkDefinition(
    {
      manifest: {
        version: 1,
        source: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
        sourceHash: "a".repeat(64),
        approvedManifestSha256: "b".repeat(64),
        accountMappingDigest: "4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945",
        totalRows: 1,
        chunks: [{ sha256: "c".repeat(64), idsSha256: "d".repeat(64), rows: 1, bytes: 1 }],
      },
      accountMappings: [],
    },
    identity,
  );
  const values = new Map<string, unknown>();
  const job = new BulkJob({
    storage: {
      get: async <T>(key: string) => structuredClone(values.get(key)) as T | undefined,
      put: async (key, value) => void values.set(key, structuredClone(value)),
    },
    setAlarm: async () => {},
    artifacts: { put: async () => {}, get: async () => null },
    validateChunk: async () => {},
    commitChunk: async () => {
      throw new Error("Contract proof must not insert history");
    },
    admit: async () => {},
    now: () => now,
  });
  await job.begin(definition);
  return { definition, job };
}

test("the hosted status codec preserves real job BEGIN and configured serving status for the CLI", async (t) => {
  const { definition, job } = await fixture();
  for (const configured of [false, true]) {
    await t.test(configured ? "configured telemetry" : "telemetry not available", async () => {
      if (configured) await job.observe(identity, guard);
      const actual = await job.status(identity);
      const decoded = Schema.decodeUnknownSync(PoolUsageBulkImportStatus)(actual);
      const wire = Schema.encodeSync(PoolUsageBulkImportStatus)(decoded);
      assert.deepEqual(wire, actual);
      assert.deepEqual(bulkStatus(wire, definition), actual);
    });
  }
});

test("the hosted guard codec retains CPU timing, release authority and optional serving evidence", async (t) => {
  for (const serving of [undefined, guard.serving]) {
    await t.test(serving ? "configured telemetry" : "telemetry not available", () => {
      const { serving: _omitted, ...required } = guard;
      const observation = { ...required, ...(serving ? { serving } : {}) };
      const command = { operation: "guard", job: "a".repeat(64), observation };
      const decoded = Schema.decodeUnknownSync(PoolUsageBulkImportInput)(command);
      assert.deepEqual(Schema.encodeSync(PoolUsageBulkImportInput)(decoded), command);
    });
  }
});

test("the hosted guard refuses missing safety evidence instead of inventing defaults", () => {
  for (const missing of ["cpuAt", "releaseReadComplete", "releaseWindowActive"]) {
    const observation = Object.fromEntries(
      Object.entries(guard).filter(([key]) => key !== missing),
    );
    assert.throws(() =>
      Schema.decodeUnknownSync(PoolUsageBulkImportInput)({
        operation: "guard",
        job: "a".repeat(64),
        observation,
      }),
    );
  }
});
