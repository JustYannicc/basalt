import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { Effect, Schema } from "effect";
import { CodeFiles, RuntimeBuildFailed } from "../../.upstream/packages/sdk/src/core.ts";
import { CompiledCloudApp } from "../../.upstream/apps/hosted/cloud/src/contracts/builds.ts";
import { cachedCompilerResult } from "../../.upstream/apps/hosted/cloud/src/implementation/compiler-result-cache.ts";

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
