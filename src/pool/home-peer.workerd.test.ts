import assert from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { loadMiniflare } from "../../scripts/startup-profiler/profile.ts";
import { homePeerWorkerd } from "../../scripts/pool-tests/home-peer-workerd.ts";

for (const direction of ["extra-to-legacy", "legacy-to-extra"]) {
  test(
    `real workerd keeps ${direction} peer upgrades open through actual Root and endpoint`,
    { timeout: 20_000 },
    async () => {
      const bundle = await build({
        stdin: {
          contents: homePeerWorkerd,
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
                  "export default { Pool: class { constructor(){ throw Error('Peer transport must not query the account database'); } } };",
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
            POOL_BLUE_APPLICATION_ID: "blue",
            POOL_BLUE_IMAGE_HASH: "b".repeat(16),
          },
          serviceBindings: { TOOLS_SERVICE: () => new Response(null, { status: 403 }) },
          outboundService: () => new Response(null, { status: 403 }),
        }),
      );
      try {
        const response = await mf.dispatchFetch(`http://fixture/${direction}`, {
          headers: {
            Upgrade: "websocket",
            "X-Signalbox-Home-Peer-Source": "untrusted original header",
          },
        });
        assert.equal(
          response.status,
          101,
          response.status === 101 ? undefined : await response.text(),
        );
        const socket = response.webSocket;
        assert.ok(socket);
        const messages: unknown[] = [];
        let next: (() => void) | undefined;
        socket.addEventListener("message", (event) => {
          messages.push(event.data);
          next?.();
        });
        socket.accept();
        const read = async () => {
          while (!messages.length)
            await new Promise<void>((resolve) => {
              next = resolve;
            });
          return messages.shift();
        };
        assert.deepEqual(JSON.parse(String(await read())), { credit: 65_536 });
        socket.send(JSON.stringify({ credit: 65_536 }));
        for (const bytes of [new Uint8Array([0, 255, 42]), new Uint8Array([7, 3, 9, 128])]) {
          socket.send(bytes);
          let reply: unknown;
          do {
            reply = await read();
          } while (typeof reply === "string");
          assert.ok(reply instanceof ArrayBuffer);
          assert.deepEqual(new Uint8Array(reply), bytes);
        }
        const closed = new Promise<number>((resolve) =>
          socket.addEventListener("close", (event) => resolve(event.code)),
        );
        socket.send(JSON.stringify({ fin: true }));
        while (
          JSON.stringify(JSON.parse(String(await read()))) !== JSON.stringify({ fin: true })
        ) {}
        assert.equal(await closed, 1000);
        assert.equal(
          (await mf.dispatchFetch("http://fixture/public", { headers: { Upgrade: "websocket" } }))
            .status,
          404,
        );
        for (const path of ["stale", "missing-source"])
          assert.equal(
            (
              await mf.dispatchFetch(`http://fixture/${path}`, {
                headers: { Upgrade: "websocket" },
              })
            ).status,
            403,
          );
      } finally {
        await mf.dispose();
      }
    },
  );
}
