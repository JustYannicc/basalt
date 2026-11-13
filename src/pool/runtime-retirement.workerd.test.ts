import assert from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { loadMiniflare } from "../../scripts/startup-profiler/profile.ts";
import { runtimeProofFixture } from "../../scripts/release-barrier/test/runtime-proof-fixture.ts";
import { runtimeRetirementWorkerd } from "../../scripts/pool-tests/runtime-retirement-workerd.ts";

test(
  "real workerd recovers retirement without replaying destruction or inventing provider absence",
  { timeout: 45_000 },
  async (context) => {
    const provider = await runtimeProofFixture();
    const bundle = await build({
      stdin: {
        contents: runtimeRetirementWorkerd,
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
          RAW_APPLICATION: provider.raw,
          POOL_RUNTIME_APPLICATION_ID: provider.raw.id,
          POOL_DATABASE_URL: "postgresql://synthetic@database.invalid/pool",
          POOL_MANAGEMENT_KEY: "synthetic-management",
          POOL_IMAGE_HASH: "b".repeat(16),
          POOL_APP_SIGNING_KEY: "a".repeat(64),
          POOL_DEPLOYMENT_KEY: "e".repeat(64),
        },
        outboundService: () => new Response(null, { status: 403 }),
      }),
    );
    const step = async (fault: string, path = "/step") => {
      const response = await mf.dispatchFetch(`http://fixture${path}?fault=${fault}`);
      return response.status === 204 ? undefined : response.json();
    };
    try {
      for (const fault of ["lost-destroy", "held-destroy", "held-report", "held-body"])
        await context.test(fault, async () => {
          try {
            const began = performance.now();
            const first = await step(fault);
            assert.ok(performance.now() - began < 3_000, "Retirement ignored its caller deadline");
            assert.equal(first.phase, "retiring");
            assert.equal(first.endpoint.destroyed, 1);
            assert.equal(first.endpoint.running, false);
            if (fault === "held-report" || fault === "held-body") await step(fault, "/release");
            const second = await step(fault);
            assert.equal(second.phase, "retired");
            assert.equal(second.endpoint.destroyed, 1);
            assert.equal(
              first.endpoint.healthCalls,
              2,
              "Drain and retirement each check health before destruction",
            );
            assert.equal(
              second.endpoint.healthCalls,
              first.endpoint.healthCalls,
              "Retirement recovery probed stopped compute",
            );
            assert.ok(
              second.inventory.some(
                (value: { kind: string; present?: boolean }) =>
                  value.kind === "instances" && value.present === false,
              ),
            );
            assert.ok(
              second.events.some(
                (event: { phase: string; retired?: boolean; running?: boolean }) =>
                  event.phase === "driver_retirement" &&
                  event.retired === true &&
                  event.running === false,
              ),
            );
            assert.ok(
              second.events.some(
                (event: { phase: string; absent?: boolean }) =>
                  event.phase === "provider_absent" && event.absent === true,
              ),
            );
            assert.equal(JSON.stringify(second.events).includes("synthetic-private"), false);
            assert.equal(JSON.stringify(second.events).includes("synthetic-token"), false);
          } finally {
            await step(fault, "/release");
          }
        });
      for (const fault of ["provider-present", "provider-unknown"])
        await context.test(fault, async () => {
          const first = await step(fault);
          const second = await step(fault);
          assert.equal(first.phase, "retiring");
          assert.equal(second.phase, "retiring");
          assert.equal(second.endpoint.destroyed, 1);
          assert.ok(
            second.events.some(
              (event: { phase: string; absent?: boolean }) =>
                event.phase === "provider_absent" && event.absent === false,
            ),
          );
          assert.ok(
            second.events.some(
              (event: { side: string; attempt: number; phase: string }) =>
                event.side === "cell" && event.phase === "attempt" && event.attempt >= 2,
            ),
          );
        });
      await context.test(
        "stopped compute without retirement intent cannot establish retirement",
        async () => {
          const value = await step("no-intent", "/observe");
          assert.equal(value.result, false);
          assert.equal(value.endpoint.destroyed, 0);
          assert.equal(value.inventory.length, 0);
        },
      );
      await context.test(
        "acknowledged destruction plus fresh provider absence retires normally",
        async () => {
          const value = await step("healthy");
          assert.equal(value.phase, "retired");
          assert.equal(value.endpoint.destroyed, 1);
        },
      );
    } finally {
      await mf.dispose();
    }
  },
);
