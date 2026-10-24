import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { Effect } from "effect";
const { makePoolAppSource } = await import(
  new URL(
    "../../.upstream/apps/hosted/cloud/src/implementation/pool-app-assets.ts",
    import.meta.url,
  ).href
);

const files = [{ path: "index.ts", content: "export default {};" }];
const version = createHash("sha256").update(JSON.stringify(files)).digest("hex");
const path = `/_basalt/pool-app-${version}.json`;

test("pool seed assets are verified and cached after a successful load", async () => {
  let reads = 0;
  const seed = makePoolAppSource(
    (requested: string) =>
      Effect.sync(() => {
        reads++;
        assert.equal(requested, path);
        return new Response(JSON.stringify(files));
      }),
    version,
    path,
  );
  assert.equal(seed.version, version);
  assert.equal(reads, 0);
  assert.deepEqual(await Effect.runPromise(seed.files), files);
  assert.deepEqual(await Effect.runPromise(seed.files), files);
  assert.equal(reads, 1);
});

test("pool seed hash mismatches fail without caching unverified files", async () => {
  let reads = 0;
  const seed = makePoolAppSource(
    () =>
      Effect.sync(
        () =>
          new Response(
            JSON.stringify(++reads === 1 ? [{ path: "index.ts", content: "tampered" }] : files),
          ),
      ),
    version,
    path,
  );
  assert.equal((await Effect.runPromise(Effect.exit(seed.files)))._tag, "Failure");
  assert.deepEqual(await Effect.runPromise(seed.files), files);
  assert.equal(reads, 2);
});

test("missing pool seed assets retry on the next use", async () => {
  let reads = 0;
  const seed = makePoolAppSource(
    () =>
      Effect.sync(() =>
        ++reads === 1 ? new Response(null, { status: 404 }) : new Response(JSON.stringify(files)),
      ),
    version,
    path,
  );
  assert.equal((await Effect.runPromise(Effect.exit(seed.files)))._tag, "Failure");
  assert.deepEqual(await Effect.runPromise(seed.files), files);
  assert.deepEqual(await Effect.runPromise(seed.files), files);
  assert.equal(reads, 2);
});

test("pool seed assets must satisfy the SDK SourceFiles schema even with a matching digest", async () => {
  const invalid = [{ path: "../index.ts", content: "export default {};" }];
  const digest = createHash("sha256").update(JSON.stringify(invalid)).digest("hex");
  const seed = makePoolAppSource(
    () => Effect.succeed(new Response(JSON.stringify(invalid))),
    digest,
  );
  assert.equal((await Effect.runPromise(Effect.exit(seed.files)))._tag, "Failure");
});
