import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { workerBuild } from "../../.upstream/apps/hosted/cloud/src/infrastructure/worker-build.ts";
import { Miniflare } from "../pool-test-runtime/index.ts";

const require = createRequire(new URL("../../.upstream/package.json", import.meta.url));
const { build } = require("esbuild") as typeof import("esbuild");
const infrastructure = fileURLToPath(
  new URL("../../.upstream/apps/hosted/cloud/src/infrastructure/", import.meta.url),
);

async function servingWorker(worker: "app-pages" | "mcp-server", configured: boolean) {
  const aliases = workerBuild(worker).input?.resolve?.alias;
  assert.ok(aliases && !Array.isArray(aliases));
  const bundle = await build({
    stdin: {
      contents: `
        import { ConfigProvider, Effect } from "effect";
        import { cloudServingProduct } from "./serving-product.ts";
        import { HostedCatalog } from "@executor-js/hosted-server";
        const services = Effect.runPromise(cloudServingProduct(undefined).pipe(
          Effect.provideService(ConfigProvider.ConfigProvider, ConfigProvider.fromUnknown({
            BETTER_AUTH_URL: "https://${worker}.invalid",
            ${configured ? 'EXECUTOR_CATALOG_URL: "https://catalog.invalid/feed/index.json",' : ""}
          }))));
        export default { async fetch(request) {
          try {
            const layer = await services;
            if (new URL(request.url).pathname === "/init") return new Response(null, { status: 204 });
            const entries = await Effect.runPromise(Effect.gen(function* () {
              return yield* (yield* HostedCatalog).list;
            }).pipe(Effect.provide(layer), Effect.scoped));
            return Response.json(entries);
          } catch (error) { return new Response(String(error), { status: 500 }); }
        } };`,
      resolveDir: infrastructure,
      sourcefile: `${worker}-catalog-fixture.ts`,
    },
    bundle: true,
    write: false,
    format: "esm",
    platform: "browser",
    target: "es2023",
    external: ["node:*", "cloudflare:workers"],
    plugins: [
      {
        name: "serving-worker-boundaries",
        setup(builder) {
          builder.onResolve({ filter: /.*/ }, (args) => {
            const path = args.path.startsWith(".")
              ? resolve(args.resolveDir, args.path)
              : args.path;
            if (path === resolve(infrastructure, "product-services.ts"))
              return { path, namespace: "unrelated-product-services" };
            const replacement = aliases[path];
            return typeof replacement === "string" ? { path: replacement } : undefined;
          });
          // The proof keeps the real serving composition, catalog, egress and event-scoped cache.
          builder.onLoad({ filter: /.*/, namespace: "unrelated-product-services" }, () => ({
            contents:
              'import { Effect, Layer } from "effect"; export const cloudProductServices = () => Effect.succeed({ services: Layer.empty });',
            resolveDir: infrastructure,
            loader: "ts",
          }));
        },
      },
    ],
  });
  const requests: string[] = [];
  const app = {
    id: "fixture-mail",
    package: "@fixture/mail",
    name: "Fixture mail",
    description: "Synthetic catalog entry",
    auth: [],
    icons: [],
    source: "apps/fixture-mail.json",
  };
  const mf = new Miniflare({
    modules: true,
    script: bundle.outputFiles[0]!.text,
    compatibilityDate: "2026-09-08",
    compatibilityFlags: ["nodejs_compat"],
    outboundService: async (request: Request) => {
      requests.push(request.url);
      assert.equal(request.url, "https://catalog.invalid/feed/index.json");
      return Response.json({ version: 1, apps: [app] });
    },
  });
  return { mf, requests, app };
}

for (const worker of ["app-pages", "mcp-server"] as const)
  for (const configured of [true, false])
    test(`${worker} serving composition resolves ${configured ? "a configured catalog across event scopes" : "an unconfigured catalog without I/O"}`, async () => {
      const { mf, requests, app } = await servingWorker(worker, configured);
      try {
        const init = await mf.dispatchFetch("https://fixture.invalid/init");
        assert.equal(init.status, 204, await init.text());
        assert.deepEqual(requests, [], "composition must not fetch the catalog");
        for (let event = 0; event < 2; event++) {
          const response = await mf.dispatchFetch("https://fixture.invalid/catalog");
          const body = await response.text();
          assert.equal(response.status, 200, body);
          const entries: unknown = JSON.parse(body);
          if (configured) assert.partialDeepStrictEqual(entries, [{ id: app.id, name: app.name }]);
          else assert.deepEqual(entries, []);
          assert.equal(requests.length, configured ? 1 : 0, "the next event uses the colo cache");
        }
      } finally {
        await mf.dispose();
      }
    });
