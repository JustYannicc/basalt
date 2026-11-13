import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { test } from "node:test";
import pg from "pg";
import { Miniflare } from "../pool-test-runtime/index.ts";
import { seriesFixture, pool } from "./series-fixture.ts";
import { digest } from "../../src/pool/backend-users.ts";
import { signEnvelope, openEnvelope } from "../../src/pool/token.ts";
import { parseUsageImport, parseBulkUsageImport } from "../../src/pool/model-history/import.ts";
import { insertRequests } from "../../src/pool/model-history/store.ts";
import {
  bulkDefinition,
  bulkImportPath,
  type BulkDefinition,
  type BulkStatus,
} from "../../src/pool/model-history/bulk-contract.ts";
import type { ImportAccountMapping } from "../../src/pool/model-history/import-account-mapping.ts";

const signingKey = "ab".repeat(32);
const identity = { pool, organization: "fixture-org", owner: "fixture-owner" };
const accountRef = "a".repeat(64);
const mapping = {
  sourceAccountRef: accountRef,
  targetAccountId: "fixture-account",
  provider: "codex",
};
const require = createRequire(
  new URL("../../.upstream/packages/sdk/package.json", import.meta.url),
);

async function nativeWorker() {
  const { build } = require("esbuild") as typeof import("esbuild");
  const bundled = await build({
    stdin: {
      contents: `
import { BulkUsageImport } from "./src/pool/model-history/bulk-do.worker.ts";
import { routeBulkImport } from "./src/pool/model-history/bulk-http.ts";
export { BulkUsageImport };
export class FixtureBulkUsageImport extends BulkUsageImport {
  offset = 0;
  now() { return Date.now() + this.offset; }
  // Dispatch the production callback explicitly so timer races cannot hide a failed guard.
  async alarm() {}
  async fetch(request) {
    if (new URL(request.url).pathname === "/__fixture/tick") {
      this.offset += 1000;
      await super.alarm();
      return new Response(null, { status: 204 });
    }
    return super.fetch(request);
  }
}
// workerd lacks jurisdiction routing; the fixture forwards to the same real namespace.
export default {
  fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/__fixture/tick")
      return env.UsageImports.getByName(url.searchParams.get("job")).fetch(request);
    const jobs = url.searchParams.get("native") === "1" ? env.NativeUsageImports : env.UsageImports;
    return routeBulkImport(request, { signingKey: env.POOL_APP_SIGNING_KEY, jobs: { jurisdiction: () => jobs } });
  }
};`,
      resolveDir: resolve("."),
      sourcefile: "bulk-import-fixture.mjs",
      loader: "js",
    },
    nodePaths: [resolve(".upstream/packages/sdk/node_modules"), resolve(".upstream/node_modules")],
    bundle: true,
    write: false,
    format: "esm",
    platform: "node",
    target: "es2023",
    conditions: ["workerd"],
    external: ["cloudflare:*", "node:*", "pg-native"],
    logLevel: "silent",
    banner: {
      js: 'import { createRequire } from "node:module"; const require = createRequire("file:///fixture.mjs");',
    },
  });
  return bundled.outputFiles[0]!.text;
}

function event(sequence: number) {
  return {
    event_hash: sequence.toString(16).padStart(64, "0"),
    timestamp: "2026-01-01T00:30:00.000000001Z",
    failed: false,
    provider: "codex",
    model: "fixture-model",
    account_ref: accountRef,
    endpoint: "/v1/responses",
    input_tokens: "100",
    output_tokens: "10",
    total_tokens: "110",
  };
}
async function plan(
  parts: string[],
  source = randomUUID(),
  accountMappings: ImportAccountMapping[] = [],
) {
  const chunks = await Promise.all(
    parts.map(async (data) => {
      const parsed = await parseBulkUsageImport(
        { source, format: "cpamp-v1-jsonl", data, accountMappings },
        { pool, person: identity.owner },
      );
      return {
        sha256: await digest(data),
        idsSha256: await digest(JSON.stringify(parsed.records.map((row) => row.id))),
        rows: parsed.records.length,
        bytes: new TextEncoder().encode(data).length,
      };
    }),
  );
  const input = {
    operation: "begin",
    accountMappings,
    manifest: {
      version: 1,
      source,
      sourceHash: await digest(parts.join("\n")),
      approvedManifestSha256: await digest("fixture-approved-manifest"),
      accountMappingDigest: await digest(JSON.stringify(accountMappings)),
      totalRows: chunks.reduce((sum, chunk) => sum + chunk.rows, 0),
      chunks,
    },
  };
  return { input, definition: await bulkDefinition(input, identity), parts };
}
const readyGuard = () => {
  const now = Date.now();
  return {
    observedAt: now,
    expiresAt: now + 90_000,
    ready: true,
    cpu: 50,
    cpuAt: now,
    releaseReadComplete: true,
    releaseWindowActive: false,
    poolErrors: 0,
    queryErrors: 0,
  };
};

test("bulk signed HTTP commands run through SQLite DO, R2 and real PostgreSQL receipts", async () => {
  await seriesFixture(async ({ db, schema }) => {
    const url = new URL(process.env.POOL_TEST_ADMIN_URL!);
    url.searchParams.delete("options");
    await db.query(`CREATE TABLE auth (id text PRIMARY KEY,provider text,disabled boolean,deleted_at timestamptz);
      CREATE TABLE channel_group (id bigint PRIMARY KEY,channel_name text,disabled boolean,deleted_at timestamptz);
      CREATE TABLE channel_group_detail (id bigint PRIMARY KEY,channel_group_id bigint,auth_id text,deleted_at timestamptz)`);
    await db.query("INSERT INTO auth VALUES ($1,'codex',false,NULL)", [mapping.targetAccountId]);
    await db.query("INSERT INTO channel_group VALUES (1,$1,false,NULL)", [
      `signalbox-pool-${pool}`,
    ]);
    await db.query("INSERT INTO channel_group_detail VALUES (1,1,$1,NULL)", [
      mapping.targetAccountId,
    ]);
    // Hyperdrive omits URL startup options. Bind this login to the isolated schema instead.
    const login = `${schema}_login`;
    await db.query(`CREATE ROLE ${login} LOGIN PASSWORD 'fixture-only' IN ROLE basalt_pool_owner`);
    await db.query(`ALTER ROLE ${login} SET search_path TO ${schema}`);
    await db.query(`GRANT ALL ON ALL TABLES IN SCHEMA ${schema} TO ${login}`);
    url.username = login;
    url.password = "fixture-only";
    let admitted = true;
    const admissions: { job: string; pool: string; owner: string; organization: string }[] = [];
    const worker = new Miniflare({
      workers: [
        {
          name: "bulk",
          compatibilityDate: "2026-09-08",
          compatibilityFlags: ["nodejs_compat"],
          modules: true,
          script: await nativeWorker(),
          bindings: { POOL_APP_SIGNING_KEY: signingKey },
          hyperdrives: { POOL_AUTH_DATABASE: url.toString() },
          durableObjects: {
            UsageImports: { className: "FixtureBulkUsageImport", useSQLite: true },
            NativeUsageImports: { className: "BulkUsageImport", useSQLite: true },
          },
          r2Buckets: ["UsageImportArtifacts"],
          serviceBindings: {
            TOOLS_SERVICE: async (request: Request) => {
              assert.equal(
                new URL(request.url).pathname,
                "/api/internal/pool-usage-import-admission",
              );
              const body = (await request.json()) as { envelope: string };
              const assertion = (await openEnvelope(signingKey, "sbq1", body.envelope)) as {
                action: string;
                job: string;
                pool: string;
                owner: string;
                organization: string;
                expiresAt: number;
              };
              assert.equal(assertion.action, "usageImportAdmission");
              assert.equal(assertion.pool, pool);
              assert.equal(assertion.organization, identity.organization);
              assert.equal(assertion.owner, identity.owner);
              assert.ok(assertion.expiresAt > Date.now());
              admissions.push(assertion);
              return new Response(null, { status: admitted ? 204 : 403 });
            },
          },
        },
      ],
    });
    try {
      await worker.ready;
      const runtime = await worker.getWorker("bulk");
      const post = async (
        input: object,
        expected = 200,
        actor = identity,
        expiresAt = Date.now() + 25_000,
        native = false,
      ) => {
        const envelope = await signEnvelope(signingKey, "sbs1", {
          action: "importUsageBulk",
          ...actor,
          user: actor.owner,
          expiresAt,
          input,
        });
        const response = await runtime.fetch(
          `https://bulk.test${bulkImportPath}${native ? "?native=1" : ""}`,
          {
            method: "POST",
            body: JSON.stringify({ envelope }),
          },
        );
        assert.equal(response.status, expected, await response.clone().text());
        return response.json() as Promise<BulkStatus>;
      };
      const status = (definition: BulkDefinition) =>
        post({ operation: "status", job: definition.job });
      const guard = (definition: BulkDefinition, observation = readyGuard()) =>
        post({ operation: "guard", job: definition.job, observation });
      // This is the real production alarm callback in workerd, not a proof of timer scheduling.
      const tick = async (definition: BulkDefinition) => {
        const response = await runtime.fetch(
          `https://bulk.test/__fixture/tick?job=${definition.job}`,
        );
        assert.equal(response.status, 204, await response.clone().text());
        await response.body?.cancel();
      };
      const stage = async (value: Awaited<ReturnType<typeof plan>>) => {
        await post(value.input);
        for (let chunk = 0; chunk < value.parts.length; chunk++)
          await post({
            operation: "upload",
            job: value.definition.job,
            chunk,
            data: value.parts[chunk],
          });
        await post({
          operation: "approve",
          job: value.definition.job,
          manifestDigest: value.definition.manifestDigest,
          accountMappingDigest: value.definition.accountMappingDigest,
        });
        await guard(value.definition);
      };
      const countRows = async () =>
        Number((await db.query("SELECT count(*)::int AS n FROM basalt_model_requests")).rows[0]!.n);
      const receipts = async (definition: BulkDefinition) =>
        (
          await db.query(
            "SELECT chunk,rows,inserted,existing FROM basalt_model_import_receipts WHERE job=$1 ORDER BY chunk",
            [definition.job],
          )
        ).rows;

      const first = await plan([
        [event(1), event(2)].map((row) => JSON.stringify(row)).join("\n"),
        JSON.stringify(event(3)),
      ]);
      const legacy = await parseUsageImport(
        {
          source: first.input.manifest.source,
          format: "cpamp-v1-jsonl",
          data: JSON.stringify(event(1)),
        },
        { pool, person: identity.owner },
      );
      await insertRequests(db, legacy.records);
      await post(first.input);
      const approval = {
        operation: "approve",
        job: first.definition.job,
        manifestDigest: first.definition.manifestDigest,
        accountMappingDigest: first.definition.accountMappingDigest,
      };
      await post(approval, 409);
      await post(
        { operation: "upload", job: first.definition.job, chunk: 0, data: first.parts[0] + " " },
        400,
      );
      await post({
        operation: "upload",
        job: first.definition.job,
        chunk: 0,
        data: first.parts[0],
      });
      await post({
        operation: "upload",
        job: first.definition.job,
        chunk: 1,
        data: first.parts[1],
      });
      await post({ ...approval, accountMappingDigest: "0".repeat(64) }, 409);
      await post(approval);
      const expired = {
        ...readyGuard(),
        observedAt: Date.now() - 90_001,
        expiresAt: Date.now() - 1,
      };
      await guard(first.definition, expired);
      const admissionsBeforeExpired = admissions.length;
      await tick(first.definition);
      assert.equal((await status(first.definition)).reason, "guard_paused");
      assert.equal(admissions.length, admissionsBeforeExpired);
      assert.equal(await countRows(), 1);
      await guard(first.definition);
      await tick(first.definition);
      const progress = await status(first.definition);
      assert.equal(progress.committedChunks, 1);
      assert.equal(progress.inserted, 1);
      assert.equal(progress.existing, 1);
      assert.equal(await countRows(), 2);
      assert.deepEqual(await receipts(first.definition), [
        { chunk: 0, rows: 2, inserted: 1, existing: 1 },
      ]);
      const bucket = await worker.getR2Bucket("UsageImportArtifacts", "bulk");
      assert.equal(
        await (await bucket.get(`usage-import-v1/${first.definition.job}/0.ndjson`))!.text(),
        first.parts[0],
      );
      await post({ operation: "pause", job: first.definition.job });
      await guard(first.definition);
      await tick(first.definition);
      assert.equal((await status(first.definition)).reason, "operator_paused");
      assert.equal(await countRows(), 2);
      await post({ operation: "resume", job: first.definition.job });
      await tick(first.definition);
      assert.equal((await status(first.definition)).state, "completed");
      assert.equal((await status(first.definition)).inserted, 2);
      assert.equal((await status(first.definition)).existing, 1);
      assert.equal((await post(first.input)).state, "completed");
      await post({ operation: "status", job: first.definition.job }, 409, {
        ...identity,
        owner: "another-owner",
      });
      await post({ operation: "status", job: first.definition.job }, 401, identity, Date.now() - 1);

      const revoked = await plan([JSON.stringify(event(4))]);
      await stage(revoked);
      admitted = false;
      const beforeRevoked = admissions.length;
      await tick(revoked.definition);
      assert.equal(admissions.length, beforeRevoked + 1);
      assert.equal((await status(revoked.definition)).reason, "admission_failed");
      assert.equal(await countRows(), 3);
      assert.deepEqual(await receipts(revoked.definition), []);
      admitted = true;
      await guard(revoked.definition);
      assert.equal((await status(revoked.definition)).state, "paused");
      await post({ operation: "resume", job: revoked.definition.job });
      await tick(revoked.definition);
      assert.equal((await status(revoked.definition)).state, "completed");

      const mapped = await plan([JSON.stringify(event(5))], randomUUID(), [mapping]);
      await stage(mapped);
      await db.query("UPDATE auth SET disabled=true WHERE id=$1", [mapping.targetAccountId]);
      await tick(mapped.definition);
      assert.equal((await status(mapped.definition)).reason, "database_error");
      assert.equal(await countRows(), 4);
      assert.deepEqual(await receipts(mapped.definition), []);
      await db.query("UPDATE auth SET disabled=false WHERE id=$1", [mapping.targetAccountId]);
      await post({ operation: "resume", job: mapped.definition.job });
      await tick(mapped.definition);
      assert.equal((await status(mapped.definition)).state, "completed");

      const changed = await plan(
        [JSON.stringify({ ...event(1), output_tokens: "99" })],
        first.input.manifest.source,
      );
      await stage(changed);
      await tick(changed.definition);
      assert.equal((await status(changed.definition)).reason, "database_error");
      assert.deepEqual(await receipts(changed.definition), []);
      assert.equal(await countRows(), 5);
      assert.equal(
        (
          await db.query(
            "SELECT output_tokens::text AS tokens FROM basalt_model_requests WHERE id=$1",
            [legacy.records[0]!.id],
          )
        ).rows[0]!.tokens,
        "10",
      );
      const maximum = await plan([
        Array.from({ length: 5000 }, (_, i) => JSON.stringify(event(100 + i))).join("\n"),
      ]);
      await stage(maximum);
      const started = performance.now();
      await tick(maximum.definition);
      assert.equal((await status(maximum.definition)).inserted, 500);
      for (
        let batch = 0;
        batch < 50 && (await status(maximum.definition)).state !== "completed";
        batch++
      )
        await tick(maximum.definition);
      const maximumStatus = await status(maximum.definition);
      assert.equal(maximumStatus.state, "completed");
      assert.equal(maximumStatus.inserted, 5000);
      assert.equal(maximumStatus.committedChunks, 1);
      assert.equal(await countRows(), 5005);
      console.info(
        JSON.stringify({
          proof: "local-maximum-chunk",
          rows: 5000,
          elapsedMs: performance.now() - started,
          productionThroughput: false,
        }),
      );

      for (const invalid of [
        { generate: { prompt: "synthetic rejected text" } },
        { source_id: { prompt: "synthetic rejected text" } },
        { source_id: "synthetic rejected text" },
        { endpoint: { prompt: "synthetic rejected text" } },
        { endpoint: ["synthetic rejected text"] },
        { endpoint: "/v1/responses?prompt=synthetic" },
        { endpoint: "synthetic rejected text" },
      ]) {
        const rejected = await plan([JSON.stringify({ ...event(7000), ...invalid })]);
        await post(rejected.input);
        await post(
          { operation: "upload", job: rejected.definition.job, chunk: 0, data: rejected.parts[0] },
          400,
        );
        assert.equal((await status(rejected.definition)).uploadedChunks, 0);
        assert.equal(await bucket.get(`usage-import-v1/${rejected.definition.job}/0.ndjson`), null);
        assert.deepEqual(await receipts(rejected.definition), []);
      }
      assert.equal(await countRows(), 5005);

      for (const data of [
        JSON.stringify(event(7200)).replace(
          '"endpoint":"/v1/responses"',
          '"endpoint":{"prompt":"synthetic rejected text"},"endpoint":null',
        ),
        JSON.stringify(event(7201)).replace(
          '"endpoint":"/v1/responses"',
          '"endpoint":"synthetic rejected text","end\\u0070oint":null',
        ),
      ]) {
        const rejected = await plan([data]);
        await post(rejected.input);
        await post({ operation: "upload", job: rejected.definition.job, chunk: 0, data }, 400);
        assert.equal((await status(rejected.definition)).uploadedChunks, 0);
        assert.equal(await bucket.get(`usage-import-v1/${rejected.definition.job}/0.ndjson`), null);
        assert.deepEqual(await receipts(rejected.definition), []);
      }

      const metadata = await plan([
        [
          { ...event(7100), source_id: "7100", generate: true, endpoint: null },
          {
            ...event(7101),
            source_id: "7101",
            generate: null,
            endpoint: "/v1beta/models/fixture-model:streamGenerateContent",
          },
        ]
          .map((row) => JSON.stringify(row))
          .join("\n"),
      ]);
      await post(metadata.input);
      await post({
        operation: "upload",
        job: metadata.definition.job,
        chunk: 0,
        data: metadata.parts[0],
      });
      assert.equal((await status(metadata.definition)).uploadedChunks, 1);
      assert.equal(
        await (await bucket.get(`usage-import-v1/${metadata.definition.job}/0.ndjson`))!.text(),
        metadata.parts[0],
      );
      assert.deepEqual(await receipts(metadata.definition), []);
      assert.equal(await countRows(), 5005);

      const native = await plan([JSON.stringify(event(6000))]);
      const channel = `bulk_${randomUUID().replaceAll("-", "")}`;
      const listener = new pg.Client({ connectionString: process.env.POOL_TEST_ADMIN_URL! });
      const committed = Promise.withResolvers<void>();
      const notified = (notification: pg.Notification) => {
        if (notification.channel === channel && notification.payload === native.definition.job)
          committed.resolve();
      };
      const listenerFailed = (error: Error) => {
        committed.reject(error);
      };
      void committed.promise.catch(() => {});
      await listener.connect();
      listener.on("notification", notified);
      listener.on("error", listenerFailed);
      try {
        await listener.query(`LISTEN ${channel}`);
        await db.query(`CREATE FUNCTION fixture_bulk_receipt_notify() RETURNS trigger LANGUAGE plpgsql AS $$
          BEGIN
            IF NEW.job = TG_ARGV[0] THEN PERFORM pg_notify(TG_ARGV[1], NEW.job); END IF;
            RETURN NEW;
          END; $$`);
        await db.query(`CREATE TRIGGER fixture_bulk_receipt_notify AFTER INSERT ON basalt_model_import_receipts
          FOR EACH ROW EXECUTE FUNCTION fixture_bulk_receipt_notify('${native.definition.job}', '${channel}')`);
        const nativePost = (input: object) => post(input, 200, identity, Date.now() + 25_000, true);
        await nativePost(native.input);
        await nativePost({
          operation: "upload",
          job: native.definition.job,
          chunk: 0,
          data: native.parts[0],
        });
        await nativePost({
          operation: "guard",
          job: native.definition.job,
          observation: readyGuard(),
        });
        await nativePost({
          operation: "approve",
          job: native.definition.job,
          manifestDigest: native.definition.manifestDigest,
          accountMappingDigest: native.definition.accountMappingDigest,
        });
        // PostgreSQL delivers NOTIFY after COMMIT. No fixture tick, polling or sleep drives this job.
        await committed.promise;
        assert.deepEqual(await receipts(native.definition), [
          { chunk: 0, rows: 1, inserted: 1, existing: 0 },
        ]);
        assert.equal(await countRows(), 5006);
        assert.equal(admissions.filter((entry) => entry.job === native.definition.job).length, 2);
        assert.equal(
          await (await bucket.get(`usage-import-v1/${native.definition.job}/0.ndjson`))!.text(),
          native.parts[0],
        );
      } finally {
        try {
          await db.query(
            "DROP TRIGGER IF EXISTS fixture_bulk_receipt_notify ON basalt_model_import_receipts",
          );
          await db.query("DROP FUNCTION IF EXISTS fixture_bulk_receipt_notify()");
        } finally {
          await listener.query(`UNLISTEN ${channel}`).catch(() => {});
          await listener.end();
          listener.off("notification", notified);
          listener.off("error", listenerFailed);
        }
      }
    } finally {
      await worker.dispose();
      await db.query(`DROP OWNED BY ${login}`);
      await db.query(`DROP ROLE ${login}`);
    }
  });
});
