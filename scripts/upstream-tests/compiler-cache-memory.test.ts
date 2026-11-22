import assert from "node:assert/strict";
import { test } from "node:test";
import { Effect } from "effect";

const upstream = new URL("../../.upstream/", import.meta.url);
const load = (path: string) => import(new URL(path, upstream).href);
const { cachedCompilerResult } = await load(
  "apps/hosted/cloud/src/implementation/compiler-result-cache.ts",
);

const MB = 1024 * 1024;
const release = "a".repeat(40);
// Shaped like an Obsidian vault's prepared filesystem on production (923 files, about 32 MB: 22 MB
// of them the release-pinned `apps` framework, 7.7 MB react-dom), here in files of 17 to 75 KB.
const text = (size: number, seed: number) => String.fromCharCode(97 + (seed % 26)).repeat(size);
const vault = () => [
  ...Array.from({ length: 300 }, (_, i) => ({
    path: `node_modules/apps/types/${i}.d.ts`,
    content: text(Math.floor((22 * MB) / 300), i),
  })),
  ...Array.from({ length: 600 }, (_, i) => ({
    path: `node_modules/react-dom/cjs/${i}.js`,
    content: text(Math.floor((10 * MB) / 600), i),
  })),
  { path: "node_modules/pkg/module.wasm", content: null, bytes: new Uint8Array(64 * 1024).fill(7) },
];
const largestFile = Math.ceil((22 * MB) / 300);
const files = [
  { path: "package.json", content: JSON.stringify({ dependencies: { apps: "1.0.0" } }) },
  { path: "index.ts", content: "export default {};" },
];
const compiled = (ui: number) => ({
  bundle: { mainModule: "index.js", modules: { "index.js": "export default {};" } },
  framework: { version: "1.0.0", modules: { "apps.js": "export {};" } },
  protocol: 1,
  ui:
    ui === 0
      ? undefined
      : [{ path: "assets/app.js", contentType: "text/javascript", body: new Uint8Array(ui) }],
  sourceMap: "{}",
});

/** Production's per-data-centre Cache API: a miss answers undefined; a put keeps the body. */
const productionCache = () => {
  const entries = new Map<string, string>();
  const puts: number[] = [];
  globalThis.caches = {
    open: async () => ({
      match: async (url: string) => {
        const body = entries.get(url);
        return body === undefined ? undefined : new Response(body);
      },
      put: async (url: string, response: Response) => {
        const body = await response.text();
        puts.push(body.length);
        entries.set(url, body);
      },
    }),
  } as unknown as CacheStorage;
  return { puts };
};

/** The largest string and byte array the cache materializes while it runs. */
const watchMaterialized = async <A>(work: () => Promise<A>) => {
  const stringify = JSON.stringify;
  const encode = TextEncoder.prototype.encode;
  let largestString = 0;
  let largestBytes = 0;
  JSON.stringify = function (...args: Parameters<typeof stringify>) {
    const value = stringify.apply(JSON, args);
    if (typeof value === "string") largestString = Math.max(largestString, value.length);
    return value;
  } as typeof stringify;
  TextEncoder.prototype.encode = function (input?: string) {
    const value = encode.call(this, input);
    largestBytes = Math.max(largestBytes, value.length);
    return value;
  };
  try {
    const value = await work();
    return { value, largestString, largestBytes };
  } finally {
    JSON.stringify = stringify;
    TextEncoder.prototype.encode = encode;
  }
};

const run = (input: {
  dependencyFiles: ReturnType<typeof vault>;
  result: ReturnType<typeof compiled>;
  counter?: { compiles: number };
}) =>
  Effect.runPromise(
    cachedCompilerResult(
      { files, publicPaths: [], release, enabled: true, dependencyFiles: input.dependencyFiles },
      Effect.sync(() => {
        if (input.counter) input.counter.compiles++;
        return input.result;
      }),
    ),
  );

test("the cache key never holds a vault's whole dependency set at once", async () => {
  productionCache();
  const watched = await watchMaterialized(() =>
    run({ dependencyFiles: vault(), result: compiled(0) }),
  );
  // Before 0731 the key was one JSON string of every file: about 32 MB here, plus its bytes.
  assert.ok(
    watched.largestString <= 2 * largestFile,
    `largest string ${(watched.largestString / MB).toFixed(1)} MB; one file is at most ${(largestFile / MB).toFixed(1)} MB`,
  );
  assert.ok(
    watched.largestBytes <= 2 * largestFile,
    `largest encoded bytes ${(watched.largestBytes / MB).toFixed(1)} MB`,
  );
});

test("a result too large for the cache is returned without being encoded", async () => {
  const { puts } = productionCache();
  // About 6 MB of characters, like Obsidian's UI and framework modules: never storable.
  const result = compiled(4 * MB);
  // A small dependency set keeps the key small, so only encoding the result could exceed 1 MB.
  const watched = await watchMaterialized(() =>
    run({ dependencyFiles: vault().slice(0, 4), result }),
  );
  assert.equal(watched.value, result);
  assert.deepEqual(puts, [], "nothing is stored");
  assert.ok(
    watched.largestString < MB,
    `encoded ${(watched.largestString / MB).toFixed(1)} MB of a result it then discarded`,
  );
});

test("a storable result is still reused, and any dependency byte change misses", async () => {
  const { puts } = productionCache();
  const counter = { compiles: 0 };
  const all = vault();
  const dependencyFiles = [...all.slice(0, 20), all.at(-1)!];
  const result = compiled(1024);
  await run({ dependencyFiles, result, counter });
  assert.equal(puts.length, 1, "the first compile is stored");
  const hit = await run({ dependencyFiles, result, counter });
  assert.equal(counter.compiles, 1, "an identical request reuses the stored compile");
  assert.equal(hit.bundle.modules["index.js"], result.bundle.modules["index.js"]);
  assert.deepEqual(hit.ui?.[0]?.body, result.ui?.[0]?.body);

  const changedBytes = dependencyFiles.map((file) =>
    file.bytes === undefined ? file : { ...file, bytes: Uint8Array.from(file.bytes, () => 8) },
  );
  await run({ dependencyFiles: changedBytes, result, counter });
  await run({
    dependencyFiles: [...dependencyFiles.slice(1), { ...dependencyFiles[0]!, content: "changed" }],
    result,
    counter,
  });
  assert.equal(counter.compiles, 3, "changed dependency bytes or text compile again");
});
