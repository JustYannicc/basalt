import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { basename } from "node:path";
import { test } from "node:test";
import * as Cloudflare from "alchemy/Cloudflare";
import type { SourceFiles } from "@executor-js/sdk/core";
import { ConfigProvider, Effect } from "effect";
import { brand, deployment } from "../../brand.ts";
import { cloudPoolAppSource } from "../../.upstream/apps/hosted/cloud/src/infrastructure/pool-app-source.ts";
import {
  poolAppAssetPath,
  poolAppVersion,
} from "../../.upstream/apps/hosted/server/src/implementation/pool-app-source.ts";

// The bundle preparation built, under the committed brand: what every stack's Worker ships.
const bundle = readFileSync(
  new URL(
    `../../.upstream/apps/hosted/cloud/.generated/pool-app/${basename(poolAppAssetPath)}`,
    import.meta.url,
  ),
  "utf8",
);
const built: SourceFiles = JSON.parse(bundle);
const text = (files: SourceFiles, path: string) => {
  const found = files.find((candidate) => candidate.path === path);
  if (found === undefined || !("content" in found) || "encoding" in found)
    return assert.fail(`the pool app has no text file ${path}`);
  return found.content;
};
const declaredOrigin = (files: SourceFiles) => {
  const declaration = /^export const poolOrigin = (.+);$/m.exec(text(files, "deployment.ts"));
  if (declaration === null) return assert.fail("deployment.ts declares no pool origin");
  return new URL(JSON.parse(declaration[1]!));
};
const builtOrigin = declaredOrigin(built);
const rewritten = ["deployment.ts", "ui/public/fonts.css"];

/** The pool app source a host with this configuration serves, read through its asset binding. */
const served = async (env: Record<string, string>) => {
  const source = await Effect.runPromise(
    cloudPoolAppSource.pipe(
      Effect.provideService(
        Cloudflare.WorkerEnvironment,
        Cloudflare.WorkerEnvironment.of({
          ASSETS: {
            fetch: async (url: string) =>
              new URL(url).pathname === poolAppAssetPath
                ? new Response(bundle)
                : new Response(null, { status: 404 }),
          },
        }),
      ),
      Effect.provideService(ConfigProvider.ConfigProvider, ConfigProvider.fromEnv({ env })),
    ),
  );
  return { version: source.version, files: await Effect.runPromise(source.files) };
};

test("a stack serves the pool app with its own origin, whatever host the bundle was built with", async () => {
  const stack = "https://app.rehearsal-1.stacks.example";
  assert.notEqual(builtOrigin.origin, stack, "the bundle was built for another host");
  const { version, files } = await served({
    ALCHEMY_STAGE: "test-rehearsal-1",
    TEST_STAGE_DOMAIN: "stacks.example",
  });
  // The pool provider declares this host, so a pool installed from this source sends its token
  // to this stack and nowhere else.
  assert.equal(declaredOrigin(files).origin, stack);
  assert.equal(
    text(files, "deployment.ts"),
    text(built, "deployment.ts").replace(builtOrigin.origin, stack),
    "only the origin changes; the product name stays",
  );
  assert.equal(
    text(files, "ui/public/fonts.css"),
    text(built, "ui/public/fonts.css").replaceAll(builtOrigin.origin, stack),
    "the stack's own router serves the fonts",
  );
  for (const one of files)
    assert.ok(
      !("content" in one) || !one.content.includes(builtOrigin.host),
      `${one.path} still names the host the bundle was built for`,
    );
  assert.deepEqual(
    files.filter(({ path }) => !rewritten.includes(path)),
    built.filter(({ path }) => !rewritten.includes(path)),
  );
  // Installed pools compare the bundle they recorded with this version.
  assert.equal(version, poolAppVersion);
});

test("production serves the bundle byte for byte, so no installed pool sees a new one", async () => {
  const production = `https://${brand.host}`;
  assert.equal(builtOrigin.origin, production, "preparation bundles under the committed brand");
  const { version, files } = await served({
    ALCHEMY_STAGE: deployment.stage,
    BETTER_AUTH_URL: production,
  });
  assert.equal(version, poolAppVersion);
  assert.equal(JSON.stringify(files), bundle);
  assert.equal(createHash("sha256").update(JSON.stringify(files)).digest("hex"), poolAppVersion);
});

test("a local e2e Cloud still serves the pool app at its own local origin under its own version", async () => {
  const local = "http://app.localhost:4321";
  const { version, files } = await served({ EXECUTOR_E2E_LOCAL_ORIGIN: local });
  assert.equal(declaredOrigin(files).origin, local);
  assert.equal(
    text(files, "ui/public/fonts.css"),
    text(built, "ui/public/fonts.css").replaceAll(builtOrigin.origin, local),
  );
  assert.equal(
    version,
    createHash("sha256")
      .update(JSON.stringify([poolAppVersion, local]))
      .digest("hex"),
  );
});
