import assert from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { loadMiniflare } from "../../scripts/startup-profiler/profile.ts";
import { poolRequestWorkerd } from "../../scripts/pool-tests/pool-request-workerd.ts";

test("real workerd records one wide event per pool request with the time spent at each hop", async (context) => {
  const bundle = await build({
    stdin: {
      contents: poolRequestWorkerd,
      resolveDir: fileURLToPath(new URL("../../", import.meta.url)),
      loader: "ts",
    },
    bundle: true,
    write: false,
    format: "esm",
    platform: "neutral",
    mainFields: ["module", "main"],
    conditions: ["workerd", "module", "import"],
    target: "es2023",
    external: ["node:*", "cloudflare:workers"],
    plugins: [
      {
        name: "unavailable-auth-database",
        setup(build) {
          build.onResolve({ filter: /^pg$/ }, () => ({ path: "pg", namespace: "unavailable" }));
          build.onLoad({ filter: /.*/, namespace: "unavailable" }, () => ({
            contents:
              "export default { Pool: class { constructor(){ throw Error('Must not query the account database'); } }, Client: class { constructor(){ throw Error('Must not query the account database'); } } };",
          }));
        },
      },
    ],
  });
  const sent: { url: string; body: string }[] = [];
  const waiting: { count: number; done: () => void }[] = [];
  const delivered = (count: number) =>
    new Promise<void>((done) => {
      if (sent.length >= count) done();
      else waiting.push({ count, done });
    });
  const { Miniflare, convertV4MiniflareOptions } = loadMiniflare();
  const mf = new Miniflare(
    convertV4MiniflareOptions({
      modules: true,
      script: bundle.outputFiles[0]!.text,
      compatibilityDate: "2026-09-08",
      compatibilityFlags: ["nodejs_compat"],
      durableObjects: { Root: { className: "Root", useSQLite: true } },
      bindings: {
        POOL_DATABASE_URL: "postgresql://synthetic@database.invalid/pool",
        POOL_AUTH_DATABASE: {
          connectionString: "postgresql://synthetic@hyperdrive.invalid/pool",
        },
        POOL_MANAGEMENT_KEY: "synthetic-management",
        POOL_IMAGE_HASH: "b".repeat(16),
        POOL_APP_SIGNING_KEY: "a".repeat(64),
        POOL_DEPLOYMENT_KEY: "e".repeat(64),
        POOL_CONTAINER_APPLICATION_ID: "legacy",
        SENTRY_DSN: "https://fixture_public_key@o0.ingest.de.sentry.io/1",
        SENTRY_OTLP_ENDPOINT: "https://o0.ingest.de.sentry.io/api/1/integration/otlp/v1/traces",
      },
      outboundService: async (request: Request) => {
        sent.push({ url: request.url, body: await request.text() });
        for (const entry of waiting.splice(0))
          if (sent.length >= entry.count) entry.done();
          else waiting.push(entry);
        return new Response(null, { status: 200 });
      },
    }),
  );
  context.after(() => mf.dispose());

  const secret = "synthetic-request-content";
  const call = (query: string) =>
    mf.dispatchFetch(`http://pool.example/v1/chat/completions?${query}`, {
      method: "POST",
      headers: {
        "X-Api-Key": "synthetic-home-key",
        "content-type": "application/json",
        // A caller cannot supply the Worker's own receive times.
        "x-basalt-pool-receive": "1000000000000,1000000000001",
      },
      body: JSON.stringify({ model: "synthetic-model-name", messages: [{ content: secret }] }),
    });

  const quick = await call("lookup=30");
  assert.equal(quick.status, 200, await quick.clone().text());
  await quick.text();
  const requestId = quick.headers.get("X-Request-Id");
  assert.match(requestId ?? "", /^[0-9a-f-]{36}$/);

  const queued = await call("occupied=400");
  assert.equal(queued.status, 200);
  await queued.text();

  const lost = await call("crash");
  assert.equal(lost.status, 502);

  // Every event is exported once; its log line is written before the export starts.
  const deadline = AbortSignal.timeout(10_000);
  await Promise.race([
    delivered(3),
    new Promise((_, reject) =>
      deadline.addEventListener("abort", () =>
        reject(new Error(`Expected three pool request traces, received ${sent.length}`)),
      ),
    ),
  ]);
  const events = (await (await mf.dispatchFetch("http://pool.example/__events")).json()) as Record<
    string,
    unknown
  >[];
  assert.equal(events.length, 3);
  const first = events.find((event) => event.requestId === requestId)!;
  const second = events.find((event) => event.requestId === queued.headers.get("X-Request-Id"))!;
  const third = events.find((event) => event.outcome === "controller_failed")!;

  // The event is the caller's request: same id the response carried, a fixed route, no content.
  assert.equal(first.method, "POST");
  assert.equal(first.path, "/v1/chat/completions");
  assert.equal(first.status, 200);
  assert.equal(first.outcome, "responded");
  assert.equal(first.kind, "model");
  assert.equal(first.port, 8317);
  assert.equal(first.boot, "11111111-1111-4111-8111-111111111111");
  assert.match(String(first.traceId), /^[0-9a-f]{32}$/);

  // The key lookup held the request in the Worker; the runtime held it before its first byte.
  assert.ok(Number(first.workerMs) >= 25, `workerMs ${first.workerMs}`);
  assert.ok(Number(first.firstByteMs) >= 35, `firstByteMs ${first.firstByteMs}`);
  // Without model history nothing reads the body, so no stream time is claimed.
  assert.equal(first.streamMs, undefined);
  // Home's own dispatch stages arrive as the runtime reported them.
  assert.equal(first.homeAuthenticateMs, 3);
  assert.equal(first.homeSelectionMs, 5);
  assert.equal(first.homeRpopMs, 21);
  assert.equal(first.homeFaults, "rpop:timeout");

  // A request that waited for a busy Durable Object shows that wait as queue time, and the
  // request held by its key lookup shows that as Worker time: neither leaks into the other.
  assert.ok(
    Number(second.queueMs) >= Number(first.queueMs) + 200,
    `queueMs ${second.queueMs} after ${first.queueMs}`,
  );
  assert.ok(
    Number(first.workerMs) >= Number(second.workerMs) + 20,
    `workerMs ${first.workerMs} after ${second.workerMs}`,
  );
  assert.ok(Number(second.firstByteMs) >= 35, `firstByteMs ${second.firstByteMs}`);

  // A call the Durable Object's own code failed is reported by the Worker. The handler ran, so
  // the wait is unanswered time, not queue time.
  assert.ok(third, JSON.stringify(events.map((event) => event.outcome)));
  assert.equal(third.path, "/v1/chat/completions");
  assert.equal(third.cause, "Error");
  assert.equal(typeof third.unansweredMs, "number");
  for (const hop of ["queueMs", "admissionMs", "dispatchMs", "firstByteMs", "status"])
    assert.equal(third[hop], undefined, hop);

  // The diagnostic project received each as one trace: the event on the root span, a span per hop.
  assert.ok(sent.every((entry) => entry.url.endsWith("/otlp/v1/traces")));
  const trace = sent.find((entry) => entry.body.includes(String(first.traceId)));
  assert.ok(trace, "OTLP trace");
  const spans = JSON.parse(trace.body).resourceSpans[0].scopeSpans[0].spans as {
    name: string;
    parentSpanId?: string;
    spanId: string;
    attributes: { key: string; value: unknown }[];
  }[];
  assert.equal(spans[0]!.name, "pool POST /v1/chat/completions");
  const attribute = (key: string) => spans[0]!.attributes.find((entry) => entry.key === key)?.value;
  assert.deepEqual(attribute("pool.requestId"), { stringValue: requestId });
  assert.deepEqual(attribute("pool.firstByteMs"), { intValue: String(first.firstByteMs) });
  assert.deepEqual(attribute("pool.queueMs"), { intValue: String(first.queueMs) });
  assert.deepEqual(attribute("pool.outcome"), { stringValue: "responded" });
  assert.ok(spans.some((span) => span.name === "pool.firstByte"));
  assert.ok(spans.slice(1).every((span) => span.parentSpanId === spans[0]!.spanId));

  // Nothing a caller or a provider wrote leaves with it.
  const recorded = JSON.stringify([events, sent]);
  for (const forbidden of [
    secret,
    "synthetic-model-name",
    "synthetic-home-key",
    "synthetic-response-content",
    "synthetic-controller-failure",
    "occupied=",
    "lookup=",
  ])
    assert.ok(!recorded.includes(forbidden), forbidden);
});
