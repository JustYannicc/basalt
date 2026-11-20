import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { basename } from "node:path";
import { test } from "node:test";
import { ConfigProvider, Effect } from "effect";

const load = (path: string) => import(new URL(`../../.upstream/${path}`, import.meta.url).href);
const { cloudPoolAppSource } = await load(
  "apps/hosted/cloud/src/infrastructure/pool-app-source.ts",
);
const { poolAppVersion, poolAppAssetPath } = await load(
  "apps/hosted/server/src/implementation/pool-app-source.ts",
);
const { WorkerEnvironment } = await import(
  new URL("../../node_modules/alchemy/lib/Cloudflare/Workers/WorkerRuntime.js", import.meta.url)
    .href
);

type File = { readonly path: string; readonly content: string };

// The bundle preparation built, under the committed brand: what every stack's Worker ships.
const bundle = readFileSync(
  new URL(
    `../../.upstream/apps/hosted/cloud/.generated/pool-app/${basename(poolAppAssetPath)}`,
    import.meta.url,
  ),
  "utf8",
);
const built: readonly File[] = JSON.parse(bundle);
const file = (files: readonly File[], path: string) => {
  const found = files.find((candidate) => candidate.path === path);
  assert.ok(found, `the pool app has ${path}`);
  return found.content;
};
const declaredOrigin = (files: readonly File[]) => {
  const declaration = /^export const poolOrigin = (.+);$/m.exec(file(files, "deployment.ts"));
  assert.ok(declaration, "deployment.ts declares the pool origin");
  return new URL(JSON.parse(declaration[1]!));
};
const builtOrigin = declaredOrigin(built);

/** The pool app source a host with this configuration serves, read through its asset binding. */
const served = async (env: Record<string, string>) => {
  const source = await Effect.runPromise(
    cloudPoolAppSource.pipe(
      Effect.provideService(WorkerEnvironment, {
        ASSETS: {
          fetch: async (url: string) =>
            new URL(url).pathname === poolAppAssetPath
              ? new Response(bundle)
              : new Response(null, { status: 404 }),
        },
      }),
      Effect.provideService(ConfigProvider.ConfigProvider, ConfigProvider.fromEnv({ env })),
    ),
  );
  return {
    version: source.version as string,
    files: (await Effect.runPromise(source.files)) as readonly File[],
  };
};

test("a stack serves the pool app with its own origin, whatever host the bundle was built with", async () => {
  const stack = "https://app.rehearsal-1.stacks.example";
  assert.notEqual(builtOrigin.origin, stack, "the bundle was built for another host");
  const { version, files } = await served({
    ALCHEMY_STAGE: "test-rehearsal-1",
    TEST_STAGE_DOMAIN: "stacks.example",
  });
  // The pool provider declares this host, so a pool token travels to this stack and nowhere else.
  assert.equal(declaredOrigin(files).origin, stack);
  assert.equal(
    file(files, "deployment.ts"),
    file(built, "deployment.ts").replace(builtOrigin.origin, stack),
    "only the origin changes; the product name stays",
  );
  assert.equal(
    file(files, "ui/public/fonts.css"),
    file(built, "ui/public/fonts.css").replaceAll(builtOrigin.origin, stack),
    "the stack's own router serves the fonts",
  );
  for (const one of files)
    assert.ok(
      !one.content.includes(builtOrigin.host),
      `${one.path} still names the host the bundle was built for`,
    );
  assert.deepEqual(
    files.filter(({ path }) => path !== "deployment.ts" && path !== "ui/public/fonts.css"),
    built.filter(({ path }) => path !== "deployment.ts" && path !== "ui/public/fonts.css"),
  );
  // Installed pools compare the bundle they recorded with this version.
  assert.equal(version, poolAppVersion);
});

test("the stack the bundle was built for serves it byte for byte, so no installed pool sees a new one", async () => {
  const { version, files } = await served({ BETTER_AUTH_URL: builtOrigin.origin });
  assert.equal(version, poolAppVersion);
  assert.equal(JSON.stringify(files), bundle);
  assert.equal(createHash("sha256").update(JSON.stringify(files)).digest("hex"), poolAppVersion);
});

test("a local e2e Cloud still serves the pool app at its own local origin under its own version", async () => {
  const local = "http://app.localhost:4321";
  const { version, files } = await served({ EXECUTOR_E2E_LOCAL_ORIGIN: local });
  assert.equal(declaredOrigin(files).origin, local);
  assert.equal(
    file(files, "ui/public/fonts.css"),
    file(built, "ui/public/fonts.css").replaceAll(builtOrigin.origin, local),
  );
  assert.equal(
    version,
    createHash("sha256")
      .update(JSON.stringify([poolAppVersion, local]))
      .digest("hex"),
  );
});
