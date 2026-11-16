import { createServer } from "node:http";
import { createHash, randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { Miniflare } from "../pool-test-runtime/index.ts";
import { bulkDefinition } from "../../src/pool/model-history/bulk-contract.ts";
import { parseBulkUsageImport } from "../../src/pool/model-history/import.ts";

const hash = (data: string) => createHash("sha256").update(data).digest("hex");
const require = createRequire(
  new URL("../../.upstream/packages/sdk/package.json", import.meta.url),
);
const { build } = require("esbuild") as typeof import("esbuild");
const bundled = await build({
  entryPoints: [resolve(import.meta.dirname, "bulk-ack-runtime.fixture.mjs")],
  absWorkingDir: resolve(import.meta.dirname, "../.."),
  nodePaths: [resolve(import.meta.dirname, "../../.upstream/node_modules")],
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
const events: { phase: string; at: number }[] = [];
const waiters = new Map<string, (() => void)[]>();
let putDelayMs = 0,
  saveDelayMs = 0,
  statusDelayMs = 0;
const note = (phase: string) => {
  events.push({ phase, at: Date.now() });
  for (const resolve of waiters.get(phase) ?? []) resolve();
  waiters.delete(phase);
};
const worker = new Miniflare({
  modules: true,
  script: bundled.outputFiles[0]!.text,
  compatibilityDate: "2026-09-08",
  compatibilityFlags: ["nodejs_compat"],
  bindings: { POOL_APP_SIGNING_KEY: "ab".repeat(32) },
  durableObjects: { Jobs: { className: "StagingFixture", useSQLite: true } },
  r2Buckets: ["UsageImportArtifacts"],
  serviceBindings: {
    GATES: async (request: Request) => {
      const phase = new URL(request.url).pathname.slice(1);
      note(phase);
      if (phase === "put-entered") await delay(putDelayMs);
      if (phase === "save-entered") await delay(saveDelayMs);
      return new Response(null, { status: 204 });
    },
  },
});
await worker.ready;
const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url!, "http://fixture");
    const parts: Buffer[] = [];
    for await (const part of request) parts.push(Buffer.from(part));
    const raw = Buffer.concat(parts).toString();
    const input = raw ? JSON.parse(raw) : undefined;
    const json = (value: unknown) => {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify(value));
    };
    if (url.pathname === "/__fixture/configure") {
      if (events.length) throw new Error("Configure each peer once before requests");
      for (const value of [input.putDelayMs ?? 0, input.saveDelayMs ?? 0, input.statusDelayMs ?? 0])
        if (!Number.isSafeInteger(value) || value < 0 || value > 70_000)
          throw new Error("Invalid fixture delay");
      ({ putDelayMs = 0, saveDelayMs = 0, statusDelayMs = 0 } = input);
      return json({ configured: true });
    }
    if (url.pathname === "/__fixture/events") return json(events);
    if (url.pathname === "/__fixture/wait") {
      const phase = url.searchParams.get("phase")!;
      if (!events.some((event) => event.phase === phase))
        await new Promise<void>((resolve) =>
          waiters.set(phase, [...(waiters.get(phase) ?? []), resolve]),
        );
      return json(events.find((event) => event.phase === phase));
    }
    if (url.pathname === "/__fixture/prepare") {
      const data = JSON.stringify({
        event_hash: hash("synthetic event"),
        timestamp: "2026-01-01T00:30:00.000000001Z",
        failed: false,
        provider: "codex",
        model: "synthetic-model",
        endpoint: "/v1/responses",
      });
      const source = randomUUID();
      const parsed = await parseBulkUsageImport(
        { source, format: "cpamp-v1-jsonl", data, accountMappings: [] },
        { pool: input.pool, person: input.owner },
      );
      const manifest = {
        version: 1,
        source,
        sourceHash: hash(data),
        approvedManifestSha256: hash("approved"),
        accountMappingDigest: hash("[]"),
        totalRows: 1,
        chunks: [
          {
            sha256: hash(data),
            idsSha256: hash(JSON.stringify(parsed.records.map((row) => row.id))),
            rows: 1,
            bytes: Buffer.byteLength(data),
          },
        ],
      };
      const definition = await bulkDefinition({ manifest, accountMappings: [] }, input);
      const result = await worker.dispatchFetch(
        `http://fixture/__fixture/prepare?job=${definition.job}`,
        {
          method: "POST",
          body: JSON.stringify(definition),
        },
      );
      if (result.status !== 200) throw new Error("Fixture state initialization failed");
      return json({ job: definition.job, data, status: await result.json() });
    }
    if (url.pathname !== "/pool/v1/usage/import/bulk") {
      response.statusCode = 404;
      return response.end();
    }
    const encoded = input.envelope.split(".")[1];
    const claims = JSON.parse(Buffer.from(encoded, "base64url").toString());
    note(`request-${claims.input.operation}`);
    if (claims.input.operation === "status") await delay(statusDelayMs);
    const result = await worker.dispatchFetch(`http://fixture${url.pathname}`, {
      method: "POST",
      body: raw,
    });
    response.statusCode = result.status;
    response.setHeader("content-type", "application/json");
    response.end(await result.text());
  } catch {
    response.statusCode = 500;
    response.end(JSON.stringify({ error: "staging_fixture_failure" }));
  }
});
await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
const address = server.address();
if (!address || typeof address === "string") throw new Error("Fixture requires TCP");
console.log(JSON.stringify({ origin: `http://127.0.0.1:${address.port}` }));
const close = async () => {
  server.closeAllConnections();
  server.close();
  await worker.dispose();
  process.exit(0);
};
process.once("SIGTERM", close);
process.once("SIGINT", close);
