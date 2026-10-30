import assert from "node:assert/strict";
import { resolve, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { test } from "node:test";
import { Effect, Exit } from "effect";

const projectRoot = fileURLToPath(new URL("../../", import.meta.url));
const upstreamRoot = resolve(process.env.BASALT_UPSTREAM_ROOT ?? join(projectRoot, ".upstream"));
type Publications = {
  status: () => Effect.Effect<{ publishing: boolean; origin: string }>;
  publish: (input: object) => Effect.Effect<unknown, unknown>;
  unpublish: (input: object) => Effect.Effect<unknown, unknown>;
  owned: (input: object) => Effect.Effect<unknown, unknown>;
};
const { makeRegistry }: {
  makeRegistry: (...args: unknown[]) => {
    registry: { list: (input: object) => Effect.Effect<unknown, unknown> };
    publications: Publications;
  };
} = await import(
  pathToFileURL(resolve(upstreamRoot, "packages/sdk/src/implementation/registry.ts")).href
);

const listing = { name: "@acme.executor.community/notes", commit: "a".repeat(40) };
// Only catalog reads may touch storage; writes die here instead of reaching it.
const storage = {
  get: () => Effect.die("no read by name expected"),
  list: () => Effect.succeed([listing]),
  owned: () => Effect.succeed([listing]),
  publish: () => Effect.die("publishing is off"),
  unpublish: () => Effect.die("publishing is off"),
};
const registry = (publishing?: boolean) =>
  makeRegistry(
    publishing === undefined ? { storage } : { storage, publishing },
    "https://executor.example",
    undefined,
    undefined,
    undefined,
  );

test("a stored catalog with publishing off stays readable and refuses publications", async () => {
  const { registry: reads, publications } = registry(false);
  assert.deepEqual(await Effect.runPromise(publications.status()), {
    publishing: false,
    origin: "https://executor.example",
  });
  assert.deepEqual(await Effect.runPromise(reads.list({})), [listing]);
  // Listings from before the switch stay visible to their owner.
  assert.deepEqual(await Effect.runPromise(publications.owned({ owner: "o" })), [listing]);
  for (const write of [
    publications.publish({ owner: "o", namespace: "acme", app: "a", commit: listing.commit }),
    publications.unpublish({ owner: "o", package: listing.name }),
  ]) {
    const exit = await Effect.runPromiseExit(write);
    assert.ok(Exit.isFailure(exit));
    assert.match(JSON.stringify(exit.cause), /"unsupported"/);
  }
});

test("a stored catalog publishes unless publishing is turned off", async () => {
  assert.equal((await Effect.runPromise(registry().publications.status())).publishing, true);
  assert.equal((await Effect.runPromise(registry(true).publications.status())).publishing, true);
});
