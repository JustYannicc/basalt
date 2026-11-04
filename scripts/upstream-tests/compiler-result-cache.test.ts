import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { createHash } from "node:crypto";
import { Effect, Schema } from "effect";
import { CodeFiles, RuntimeBuildFailed } from "../../.upstream/packages/sdk/src/core.ts";
import { CompiledCloudApp } from "../../.upstream/apps/hosted/cloud/src/contracts/builds.ts";
import { cachedCompilerResult } from "../../.upstream/apps/hosted/cloud/src/implementation/compiler-result-cache.ts";

import { compilerCacheRelease } from "../../.upstream/apps/hosted/cloud/src/implementation/compiler-cache-config.ts";

const source = (text = "export default {}", version = "1.2.3") =>
  Schema.decodeUnknownSync(CodeFiles)([
    { path: "index.ts", content: text },
    { path: "package.json", content: JSON.stringify({ dependencies: { apps: version } }) },
  ]);
const output = CompiledCloudApp.make({
  bundle: {
    mainModule: "index.js",
    modules: {
      "index.js": "export default {}",
      "sample.wasm": { wasm: new Uint8Array([0, 97, 115, 109]) },
    },
  },
  framework: { version: "1.2.3", modules: { "framework.js": "export default {}" } },
  protocol: 1,
  ui: [{ path: "/app.js", contentType: "text/javascript", body: new Uint8Array([48, 49]) }],
  sourceMap: "{}",
});
const input = (files = source(), release: string | undefined = "release-one") => ({
  files,
  release,
  enabled: true,
  dependencyFiles: [{ path: "node_modules/scheduler/index.js", content: "exports.value = 1" }],
  publicPaths: ["logo.png"],
});

const cacheFixture = (context: TestContext) => {
  const entries = new Map<string, Response>();
  const original = Object.getOwnPropertyDescriptor(globalThis, "caches");
  Object.defineProperty(globalThis, "caches", {
    configurable: true,
    value: {
      open: async () => ({
        match: async (url: string) => entries.get(url)?.clone(),
        put: async (url: string, response: Response) => {
          entries.set(url, response);
        },
      }),
    },
  });
  context.after(() => {
    if (original === undefined) Reflect.deleteProperty(globalThis, "caches");
    else Object.defineProperty(globalThis, "caches", original);
  });
  let compiles = 0;
  const compile = Effect.sync(() => {
    compiles++;
    return structuredClone(output);
  });
  return { entries, compile, compiles: () => compiles };
};

test("a second identical pool source skips compilation; changed source compiles", async (context) => {
  const fixture = cacheFixture(context);
  const first = await Effect.runPromise(cachedCompilerResult(input(), fixture.compile));
  const second = await Effect.runPromise(cachedCompilerResult(input(), fixture.compile));
  assert.equal(fixture.compiles(), 1);
  assert.deepEqual(second, first);
  // Each hit decodes fresh buffers. A caller cannot mutate a later create's output.
  second.ui?.[0]?.body.fill(255);
  const third = await Effect.runPromise(cachedCompilerResult(input(), fixture.compile));
  assert.deepEqual(third, first);
  await Effect.runPromise(
    cachedCompilerResult(input(source("export default { changed: true }")), fixture.compile),
  );
  assert.equal(fixture.compiles(), 2);
});

test("compiler release and public paths are part of the cache identity", async (context) => {
  const fixture = cacheFixture(context);
  await Effect.runPromise(cachedCompilerResult(input(), fixture.compile));
  await Effect.runPromise(cachedCompilerResult(input(source(), "release-two"), fixture.compile));
  await Effect.runPromise(
    cachedCompilerResult({ ...input(), publicPaths: ["other.png"] }, fixture.compile),
  );
  assert.equal(fixture.compiles(), 3);
});

test("source ordering does not recompile identical unique files", async (context) => {
  const fixture = cacheFixture(context);
  const files = source();
  await Effect.runPromise(cachedCompilerResult(input(files), fixture.compile));
  await Effect.runPromise(
    cachedCompilerResult(
      input(Schema.decodeUnknownSync(CodeFiles)([...files].reverse())),
      fixture.compile,
    ),
  );
  assert.equal(fixture.compiles(), 1);
});

for (const version of [
  "latest",
  "^1.2.3",
  "~1.2.3",
  "1.x",
  "workspace:*",
  "https://registry.invalid/apps.tgz",
]) {
  test(`floating dependency ${version} bypasses the cache`, async (context) => {
    const fixture = cacheFixture(context);
    await Effect.runPromise(
      cachedCompilerResult(input(source(undefined, version)), fixture.compile),
    );
    await Effect.runPromise(
      cachedCompilerResult(input(source(undefined, version)), fixture.compile),
    );
    assert.equal(fixture.compiles(), 2);
    assert.equal(fixture.entries.size, 0);
  });
}

test("test framework and custom registry callers bypass even an existing hit", async (context) => {
  const fixture = cacheFixture(context);
  await Effect.runPromise(cachedCompilerResult(input(), fixture.compile));
  await Effect.runPromise(cachedCompilerResult({ ...input(), enabled: false }, fixture.compile));
  await Effect.runPromise(
    cachedCompilerResult({ ...input(), release: undefined }, fixture.compile),
  );
  assert.equal(fixture.compiles(), 3);
});

test("failed compiles never populate the cache", async (context) => {
  const fixture = cacheFixture(context);
  const failure = Effect.fail(new RuntimeBuildFailed({ stage: "compile" }));
  await assert.rejects(Effect.runPromise(cachedCompilerResult(input(), failure)));
  assert.equal(fixture.entries.size, 0);
  await Effect.runPromise(cachedCompilerResult(input(), fixture.compile));
  assert.equal(fixture.compiles(), 1);
});

test("invalid cache output is a miss and is replaced by a successful compile", async (context) => {
  const fixture = cacheFixture(context);
  await Effect.runPromise(cachedCompilerResult(input(), fixture.compile));
  const key = fixture.entries.keys().next().value;
  assert.ok(key);
  fixture.entries.set(key, new Response('{"bundle":null}'));
  const result = await Effect.runPromise(cachedCompilerResult(input(), fixture.compile));
  assert.deepEqual(result, output);
  assert.equal(fixture.compiles(), 2);
});

test("cache read and write failures preserve successful compilation", async (context) => {
  const fixture = cacheFixture(context);
  Object.defineProperty(globalThis, "caches", {
    configurable: true,
    value: {
      open: async () => ({
        match: async () => {
          throw new Error("unavailable");
        },
        put: async () => {
          throw new Error("unavailable");
        },
      }),
    },
  });
  const result = await Effect.runPromise(cachedCompilerResult(input(), fixture.compile));
  assert.deepEqual(result, output);
  assert.equal(fixture.compiles(), 1);
});

test("floating dependencies in nested manifests or optional groups bypass reuse", async (context) => {
  const fixture = cacheFixture(context);
  for (const manifest of [
    { dependencies: { apps: "1.2.3" }, optionalDependencies: { react: "^19.0.0" } },
    { dependencies: { apps: "1.2.3" }, devDependencies: { vite: "latest" } },
  ]) {
    const files = Schema.decodeUnknownSync(CodeFiles)(
      source().map((file) =>
        file.path === "package.json" ? { ...file, content: JSON.stringify(manifest) } : file,
      ),
    );
    await Effect.runPromise(cachedCompilerResult(input(files), fixture.compile));
  }
  const nested = Schema.decodeUnknownSync(CodeFiles)([
    ...source(),
    {
      path: "ui/package.json",
      content: JSON.stringify({ dependencies: { react: "^19.0.0" } }),
    },
  ]);
  await Effect.runPromise(cachedCompilerResult(input(nested), fixture.compile));
  assert.equal(fixture.entries.size, 0);
});

test("an interrupted compile retains no partial output", async (context) => {
  const fixture = cacheFixture(context);
  const started = Promise.withResolvers<void>();
  const controller = new AbortController();
  const pending = Effect.runPromise(
    cachedCompilerResult(
      input(),
      Effect.sync(() => started.resolve()).pipe(Effect.andThen(Effect.never)),
    ),
    { signal: controller.signal },
  );
  await started.promise;
  controller.abort();
  await assert.rejects(pending);
  assert.equal(fixture.entries.size, 0);
});

test("oversized successful output is returned without retaining a cache entry", async (context) => {
  const fixture = cacheFixture(context);
  const large = { ...output, sourceMap: " ".repeat(4 * 1024 * 1024) };
  const result = await Effect.runPromise(cachedCompilerResult(input(), Effect.succeed(large)));
  assert.equal(result.sourceMap.length, large.sourceMap.length);
  assert.equal(fixture.entries.size, 0);
});

test("a newly resolved transitive dependency or framework asset cannot reuse old output", async (context) => {
  const fixture = cacheFixture(context);
  await Effect.runPromise(cachedCompilerResult(input(), fixture.compile));
  for (const dependencyFiles of [
    [{ path: "node_modules/scheduler/index.js", content: "exports.value = 2" }],
    [
      ...input().dependencyFiles,
      { path: "node_modules/apps/runtime.json", content: "new framework" },
    ],
    [
      ...input().dependencyFiles,
      { path: "node_modules/asset/bytes.wasm", content: null, bytes: [0, 1] },
    ],
    [
      ...input().dependencyFiles,
      { path: "node_modules/asset/bytes.wasm", content: null, bytes: [0, 2] },
    ],
  ])
    await Effect.runPromise(cachedCompilerResult({ ...input(), dependencyFiles }, fixture.compile));
  assert.equal(fixture.compiles(), 5);
});

const production = {
  stage: "production",
  release: "a".repeat(40),
  registry: undefined,
  framework: "/released/framework",
  expectedFramework: "/released/framework",
  version: "1.2.3",
  expectedVersion: "1.2.3",
};
test("the compiler caller excludes inherited test releases, registries and framework overrides", () => {
  assert.equal(compilerCacheRelease(production), production.release);
  for (const config of [
    { ...production, stage: "test-e2e-cache" },
    { ...production, stage: "development" },
    { ...production, stage: undefined },
    { ...production, framework: "/test/framework" },
    { ...production, version: "1.2.4" },
    { ...production, registry: "https://registry.example.test" },
    { ...production, expectedFramework: undefined },
    { ...production, release: undefined },
  ])
    assert.equal(compilerCacheRelease(config), undefined);
});

for (const damage of ["javascript", "entry", "binary"] as const) {
  test(`valid JSON with damaged ${damage} is a miss`, async (context) => {
    const fixture = cacheFixture(context);
    await Effect.runPromise(cachedCompilerResult(input(), fixture.compile));
    const key = fixture.entries.keys().next().value;
    assert.ok(key);
    const envelope = JSON.parse(await fixture.entries.get(key)!.clone().text());
    const payload = JSON.parse(envelope.payload);
    if (damage === "javascript") payload.bundle.modules["index.js"] = "broken javascript {{{";
    if (damage === "binary") payload.bundle.modules["sample.wasm"].wasm = "AAAA";
    if (damage === "entry") payload.bundle.mainModule = "missing.js";
    envelope.payload = JSON.stringify(payload);
    // Even a correctly checksummed record must describe an executable entry module.
    if (damage === "entry")
      envelope.digest = createHash("sha256").update(envelope.payload).digest("hex");
    fixture.entries.set(key, new Response(JSON.stringify(envelope)));
    const value = await Effect.runPromise(cachedCompilerResult(input(), fixture.compile));
    assert.deepEqual(value, output);
    assert.equal(fixture.compiles(), 2);
  });
}

test("server-only output survives the JSON cache boundary without a UI field", async (context) => {
  cacheFixture(context);
  let count = 0;
  const compile = Effect.sync(() => {
    count++;
    return { ...output, ui: undefined };
  });
  await Effect.runPromise(cachedCompilerResult(input(), compile));
  const hit = await Effect.runPromise(cachedCompilerResult(input(), compile));
  assert.equal(hit.ui, undefined);
  assert.equal(count, 1);
});
