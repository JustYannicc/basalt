import assert from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { loadMiniflare } from "../../scripts/startup-profiler/profile.ts";
import { runtimeAlarmWorkerd } from "../../scripts/pool-tests/runtime-alarm-workerd.ts";

test(
  "native workerd accepts the first start alarm and dispatches real runtime upkeep",
  { timeout: 20_000 },
  async (context) => {
    const bundle = await build({
      stdin: {
        contents: runtimeAlarmWorkerd,
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
          name: "no-account-database",
          setup(build) {
            build.onResolve({ filter: /^pg$/ }, () => ({ path: "pg", namespace: "unavailable" }));
            build.onLoad({ filter: /.*/, namespace: "unavailable" }, () => ({
              contents:
                "export default { Pool: class { constructor(){ throw Error('Alarm proof cannot use the account database'); } } };",
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
        durableObjects: { Extra: { className: "Extra", useSQLite: true } },
        bindings: {
          POOL_DATABASE_URL: "postgresql://synthetic@database.invalid/pool",
          POOL_MANAGEMENT_KEY: "synthetic-management",
          POOL_IMAGE_HASH: "c".repeat(16),
          POOL_APP_SIGNING_KEY: "a".repeat(64),
          POOL_DEPLOYMENT_KEY: "e".repeat(64),
          POOL_RUNTIME_APPLICATION_ID: "blue",
          POOL_BLUE_APPLICATION_ID: "blue",
          POOL_BLUE_IMAGE_HASH: "c".repeat(16),
        },
        outboundService: () => new Response(null, { status: 403 }),
      }),
    );
    try {
      const interrupted = new Promise<never>((_resolve, reject) => {
        context.signal.addEventListener("abort", () => reject(context.signal.reason), {
          once: true,
        });
      });
      const start = await Promise.race([mf.dispatchFetch("http://fixture/start"), interrupted]);
      assert.equal(start.status, 200, await start.clone().text());
      const before = await (await mf.dispatchFetch("http://fixture/stats")).json();
      assert.equal(before.starts, 1);
      assert.equal(before.keepAlive, 1);
      assert.ok(before.alarm > Date.now());
      assert.equal((await mf.dispatchFetch("http://fixture/arm")).status, 200);
      await (
        await Promise.race([mf.dispatchFetch("http://fixture/await"), interrupted])
      ).body?.cancel();
      const after = await (await mf.dispatchFetch("http://fixture/stats")).json();
      assert.equal(after.starts, 1);
      assert.equal(after.keepAlive, 2);
      assert.ok(after.health > before.health);
      assert.ok(after.alarm > Date.now());
      const stopped = await (await mf.dispatchFetch("http://fixture/stop")).json();
      assert.equal(stopped.starts, 1);
      assert.equal(stopped.keepAlive, 2);
    } finally {
      await mf.dispose();
    }
  },
);
