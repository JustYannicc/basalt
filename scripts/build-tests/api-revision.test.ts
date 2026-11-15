import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import * as BrowserCrypto from "@effect/platform-browser/BrowserCrypto";
import { hostedApiRevision } from "@executor-js/hosted-server";
import { Effect } from "effect";
import { executorCloudApiDocument } from "../../.upstream/apps/hosted/cloud/src/contracts/api.ts";
import {
  builtApiOrigin,
  servesBuiltApiDocument,
} from "../../.upstream/apps/hosted/cloud/src/contracts/browser.ts";
import { cloudDevelopmentOrigin } from "../../.upstream/apps/hosted/cloud/src/contracts/development.ts";
import { workerBuild } from "../../.upstream/apps/hosted/cloud/src/infrastructure/worker-build.ts";

const require = createRequire(new URL("../../.upstream/package.json", import.meta.url));
const { build } = require("esbuild") as typeof import("esbuild");
const infrastructure = fileURLToPath(
  new URL("../../.upstream/apps/hosted/cloud/src/infrastructure/", import.meta.url),
);
const resolver = resolve(infrastructure, "api-revision.ts");

function aliases(origin: string | undefined) {
  const configured = workerBuild("app-pages", { apiRevisionOrigin: origin }).input?.resolve?.alias;
  assert.ok(configured && !Array.isArray(configured));
  return configured;
}

/** Exercise the resolver selected by the same aliases the production Worker receives. */
async function bundledRevision(origin: string | undefined) {
  const configured = aliases(origin);
  const bundled = await build({
    stdin: {
      contents: `import { cloudApiRevision } from "./api-revision.ts";
        import * as BrowserCrypto from "@effect/platform-browser/BrowserCrypto";
        import { Effect } from "effect";
        export const revision = (origin) => Effect.runPromise(
          cloudApiRevision(origin).pipe(Effect.provide(BrowserCrypto.layer)));`,
      resolveDir: infrastructure,
      sourcefile: "api-revision-fixture.ts",
    },
    plugins: [
      {
        name: "production-api-revision-alias",
        setup(builder) {
          builder.onResolve({ filter: /api-revision[.]ts$/ }, (args) => {
            const replacement = configured[resolve(args.resolveDir, args.path)];
            return typeof replacement === "string" ? { path: replacement } : undefined;
          });
        },
      },
    ],
    bundle: true,
    format: "esm",
    write: false,
    platform: "node",
  });
  const output = bundled.outputFiles[0];
  assert.ok(output);
  return (await import(
    `data:text/javascript;base64,${Buffer.from(output.text).toString("base64")}`
  )) as {
    revision: (origin: string | undefined) => Promise<string>;
  };
}

test("app-page revision specialization hashes the exact API document for every origin class", async () => {
  const hosts = ["example.invalid", "api.example.invalid", "localhost", "127.0.0.1", "[::1]"];
  const origins = [
    undefined,
    cloudDevelopmentOrigin,
    ...hosts.flatMap((host) =>
      ["http:", "https:"].flatMap((scheme) =>
        ["", ":3000", ":5395", ":8443"].map((port) => `${scheme}//${host}${port}`),
      ),
    ),
  ];
  const fallback = await bundledRevision("http://localhost:3000");
  const specialized = await bundledRevision(builtApiOrigin);
  for (const origin of origins) {
    const expected = await Effect.runPromise(
      hostedApiRevision(JSON.stringify(executorCloudApiDocument(origin ?? builtApiOrigin))).pipe(
        Effect.provide(BrowserCrypto.layer),
      ),
    );
    assert.equal(await fallback.revision(origin), expected, `original resolver: ${origin}`);
    const selected = aliases(origin)[resolver] === undefined ? fallback : specialized;
    assert.equal(await selected.revision(origin), expected, `production resolver: ${origin}`);
  }
  assert.notEqual(
    await fallback.revision(cloudDevelopmentOrigin),
    await specialized.revision(builtApiOrigin),
    "the development cookie contract must not use the publication's revision",
  );
  assert.equal(aliases(undefined)[resolver], undefined, "an unknown origin keeps its resolver");
  for (const origin of origins.filter((value) => value !== undefined))
    assert.equal(aliases(origin)[resolver] !== undefined, servesBuiltApiDocument(origin), origin);
});
