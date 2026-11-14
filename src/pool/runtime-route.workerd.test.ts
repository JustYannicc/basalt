import assert from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { loadMiniflare } from "../../scripts/startup-profiler/profile.ts";
import { runtimeRouteWorkerd } from "../../scripts/pool-tests/runtime-route-workerd.ts";

test(
  "real workerd preserves closed routing refusal reasons across native DO fetch without dispatch or private text",
  { timeout: 20_000 },
  async (context) => {
    const bundle = await build({
      stdin: {
        contents: runtimeRouteWorkerd,
        resolveDir: fileURLToPath(new URL("../../", import.meta.url)),
        loader: "ts",
      },
      bundle: true,
      write: false,
      format: "esm",
      platform: "neutral",
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
                "export default { Pool: class { constructor(){ throw Error('Must not query account database'); } } };",
            }));
          },
        },
      ],
    });
    const { Miniflare, convertV4MiniflareOptions } = loadMiniflare();
    const mf = new Miniflare(
      convertV4MiniflareOptions({
        modules: true,
        script: bundle.outputFiles[0]!.text,
        compatibilityDate: "2026-09-08",
        compatibilityFlags: ["nodejs_compat"],
        durableObjects: {
          Root: { className: "Root", useSQLite: true },
          Extra: { className: "Extra", useSQLite: true },
        },
        bindings: {
          POOL_DATABASE_URL: "postgresql://synthetic@database.invalid/pool",
          POOL_MANAGEMENT_KEY: "synthetic-management",
          POOL_IMAGE_HASH: "b".repeat(16),
          POOL_APP_SIGNING_KEY: "a".repeat(64),
          POOL_DEPLOYMENT_KEY: "e".repeat(64),
          POOL_CONTAINER_APPLICATION_ID: "legacy",
          POOL_RUNTIME_APPLICATION_ID: "blue",
        },
        outboundService: () => new Response(null, { status: 403 }),
      }),
    );
    try {
      for (const [fault, phase] of [
        ["read-health-headers", "health_headers"],
        ["read-health-body", "health_body"],
        ["read-port-headers", "port_headers"],
      ])
        await context.test(fault!, async () => {
          await mf.dispatchFetch(`http://fixture/clear-read-events?fault=${fault}`);
          const response = await mf.dispatchFetch(`http://fixture/probe?fault=${fault}`);
          if (fault === "read-port-headers") {
            assert.equal(response.status, 200);
            assert.deepEqual(await response.json(), { caps: true });
          } else {
            assert.equal(response.status, 200);
            assert.deepEqual(await response.json(), {
              refused: true,
              diagnostic: { runtimeStep: "endpoint_health", runtimeReason: "aborted" },
            });
          }
          const eventsResponse = await mf.dispatchFetch(
            `http://fixture/read-events?fault=${fault}`,
          );
          const events = await eventsResponse.json();
          const aborted = events.filter(
            (event: { outcome: string }) => event.outcome === "aborted",
          );
          assert.equal(aborted.length, 1, JSON.stringify(events));
          assert.equal(aborted[0].phase, phase);
          assert.ok(aborted[0].elapsedMs >= 30);
          assert.ok(aborted[0].readElapsedMs >= aborted[0].elapsedMs);
          assert.equal(JSON.stringify(events).includes("synthetic-private"), false);
          assert.equal(JSON.stringify(events).includes("synthetic-management"), false);
          assert.equal(
            events.some(
              (event: { phase: string; outcome: string; port: number }) =>
                event.phase === "port_headers" && event.outcome === "ok" && event.port === 8329,
            ),
            fault === "read-port-headers",
          );
          if (fault === "read-port-headers")
            assert.ok(
              events.some(
                (event: { phase: string; outcome: string; elapsedMs: number }) =>
                  event.phase === phase && event.outcome === "pending" && event.elapsedMs >= 900,
              ),
            );
          const state = await mf.dispatchFetch(`http://fixture/read-state?fault=${fault}`);
          assert.partialDeepStrictEqual(await state.json(), {
            phase: "draining",
            active: 1,
            known: true,
          });
          const calls = await mf.dispatchFetch(`http://fixture/calls?fault=${fault}`);
          assert.equal((await calls.json()).calls, 0);
        });
      for (const [fault, phase] of [
        ["read-timeout-headers", "health_headers"],
        ["read-timeout-body", "health_body"],
      ])
        await context.test(fault!, async () => {
          await mf.dispatchFetch(`http://fixture/clear-read-events?fault=${fault}`);
          try {
            const started = performance.now();
            const response = await mf.dispatchFetch(`http://fixture/probe?fault=${fault}`);
            assert.equal(response.status, 200);
            assert.ok(
              performance.now() - started < 2_500,
              "Health read waited past its lease window",
            );
            assert.deepEqual(await response.json(), {
              refused: true,
              diagnostic: { runtimeStep: "endpoint_health", runtimeReason: "timeout" },
            });
            const eventsResponse = await mf.dispatchFetch(
              `http://fixture/read-events?fault=${fault}`,
            );
            const events = await eventsResponse.json();
            assert.ok(
              events.some(
                (event: { phase: string; outcome: string }) =>
                  event.phase === phase && event.outcome === "error",
              ),
            );
            assert.equal(
              events.some(
                (event: { phase: string }) =>
                  event.phase === "request_prepare" || event.phase === "port_headers",
              ),
              false,
            );
            await mf.dispatchFetch(`http://fixture/release-health?fault=${fault}`);
            const cleaned = await mf.dispatchFetch(`http://fixture/health-cleaned?fault=${fault}`);
            assert.deepEqual(await cleaned.json(), { cancelled: 1, aborted: true });
            const state = await mf.dispatchFetch(`http://fixture/read-state?fault=${fault}`);
            assert.partialDeepStrictEqual(await state.json(), {
              phase: "draining",
              active: 1,
              known: true,
            });
            const calls = await mf.dispatchFetch(`http://fixture/calls?fault=${fault}`);
            assert.equal((await calls.json()).calls, 0);
          } finally {
            await mf.dispatchFetch(`http://fixture/release-health?fault=${fault}`);
          }
        });
      await mf.dispatchFetch("http://fixture/clear-read-events?fault=read-port-headers");
      for (const [fault, reason] of [
        ["acquire", "runtime_fleet_acquire_transport"],
        ["primary", "runtime_primary_forward_transport"],
        ["identity", "runtime_fleet_identity_fleet_uncertain"],
        ["health", "runtime_endpoint_health_unhealthy"],
        ["selection", "runtime_slot_selection_slot_selection"],
        ["invalid-metadata", "runtime_slot_health_slot_uncertain"],
        ["port-lookup", "runtime_port_lookup_transport"],
        ["boot", "runtime_endpoint_identity_slot_identity"],
        ["short-lease", "runtime_slot_protection_protection_lease_too_short"],
        ["missing-port", "runtime_port_lookup_transport"],
      ])
        await context.test(fault!, async () => {
          const response = await mf.dispatchFetch(`http://fixture/v1/messages?fault=${fault}`, {
            method: "POST",
            body: "{}",
          });
          assert.equal(response.status, 503);
          const text = await response.text();
          assert.equal(text.includes("synthetic-private-exception-body"), false);
          const value = JSON.parse(text);
          assert.equal(value.error.code, "pool_protection_unavailable");
          assert.equal(value.error.reason, reason);
          const calls = await mf.dispatchFetch(`http://fixture/calls?fault=${fault}`);
          assert.equal((await calls.json()).calls, 0);
        });
      for (const [fault, count] of [
        ["model-port-lookup", 0],
        ["model-port-dispatch", 1],
      ] as const)
        await context.test(fault, async () => {
          const response = await mf.dispatchFetch(`http://fixture/v1/messages?fault=${fault}`, {
            method: "POST",
            body: "{}",
          });
          assert.equal(response.status, 502);
          assert.equal(response.headers.get("Retry-After"), null);
          assert.equal(response.headers.get("X-Signalbox-Runtime-Failure-Step"), null);
          assert.equal(response.headers.get("X-Signalbox-Runtime-Failure-Reason"), null);
          const text = await response.text();
          assert.equal(text.includes("synthetic-private-exception-body"), false);
          assert.partialDeepStrictEqual(JSON.parse(text), {
            error: { code: "upstream_outcome_unknown", retryable: false },
          });
          const calls = await mf.dispatchFetch(`http://fixture/calls?fault=${fault}`);
          assert.equal((await calls.json()).calls, count);
        });
      await context.test("healthy ready extra remains routable", async () => {
        const response = await mf.dispatchFetch("http://fixture/v1/messages?fault=healthy", {
          method: "POST",
          body: "{}",
        });
        assert.equal(
          response.status,
          200,
          JSON.stringify({ body: await response.clone().text(), headers: [...response.headers] }),
        );
        assert.deepEqual(await response.json(), { ok: true });
        const calls = await mf.dispatchFetch("http://fixture/calls?fault=healthy");
        assert.equal((await calls.json()).calls, 1);
        const events = await mf.dispatchFetch("http://fixture/read-events?fault=healthy");
        assert.deepEqual(await events.json(), []);
      });
    } finally {
      await mf.dispose();
    }
  },
);
