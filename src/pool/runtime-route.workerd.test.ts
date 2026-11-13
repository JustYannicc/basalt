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
      for (const [fault, reason, count] of [
        ["model-port-lookup", "runtime_port_lookup_transport", 0],
        ["model-port-dispatch", "runtime_port_dispatch_transport", 1],
      ] as const)
        await context.test(fault, async () => {
          const response = await mf.dispatchFetch(`http://fixture/v1/messages?fault=${fault}`, {
            method: "POST",
            body: "{}",
          });
          assert.equal(response.status, 409);
          assert.equal(response.headers.get("X-Signalbox-Runtime-Failure-Step"), null);
          assert.equal(response.headers.get("X-Signalbox-Runtime-Failure-Reason"), null);
          const text = await response.text();
          assert.equal(text.includes("synthetic-private-exception-body"), false);
          assert.deepEqual(JSON.parse(text), { error: "runtime-refused", reason });
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
      });
    } finally {
      await mf.dispose();
    }
  },
);
