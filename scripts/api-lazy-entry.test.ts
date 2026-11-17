import assert from "node:assert/strict";
import { realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";

// The Alchemy the hosted Cloud bundles with, and the Effect it runs on, so Layers and tags match.
const alchemy = dirname(
  realpathSync(
    new URL("../.upstream/apps/hosted/cloud/node_modules/alchemy/package.json", import.meta.url),
  ),
);
const own = createRequire(join(alchemy, "package.json"));
const load = (path: string) => import(pathToFileURL(path).href);
const { makeEffectVirtualEntry } = await load(
  join(alchemy, "lib/Cloudflare/Workers/Sources/Rolldown.js"),
);
const { lazyEntrypoint, makeEntrypointLayer } = await load(join(alchemy, "lib/Runtime.js"));
const Effect = await load(own.resolve("effect/Effect"));
const Layer = await load(own.resolve("effect/Layer"));
const Context = await load(own.resolve("effect/Context"));

const exports = {
  ScheduleCoordinator: { kind: "durableObject" },
  OrganizationRemovalRecovery: { kind: "durableObject" },
  Provisioning: { kind: "workflow" },
  AppWorkflows: { kind: "workflow" },
};
const stack = { name: "fixture", stage: "production" };
const main = "/app/src/main.ts";
const exported = (entry: string) =>
  [...entry.matchAll(/^export (?:default|class (\w+))/gm)].map((match) => match[1] ?? "default");

test("the lazy entry keeps every export and imports the main module only on demand", () => {
  const eager = makeEffectVirtualEntry(exports, stack)(main);
  const lazy = makeEffectVirtualEntry(exports, stack, { lazy: true })(main);
  assert.deepEqual(exported(lazy), exported(eager));
  assert.deepEqual(exported(lazy).toSorted(), ["default", ...Object.keys(exports)].toSorted());
  assert.match(eager, /^import entrypoint from "\/app\/src\/main\.ts";$/m);
  assert.doesNotMatch(lazy, /^import entrypoint from/m);
  assert.match(
    lazy,
    /const entrypoint = lazyEntrypoint\(\(\) => import\("\/app\/src\/main\.ts"\)\);/,
  );
  // Everything else the bridges read is the same text.
  const strip = (entry: string) =>
    entry
      .replace(/^import entrypoint from .*$/m, "")
      .replace(/^const entrypoint = lazyEntrypoint.*$/m, "")
      .replace(", lazyEntrypoint", "");
  assert.equal(strip(lazy), strip(eager));
});

test("a lazy entrypoint loads its module once its layer builds, for Effect and Layer exports", async () => {
  const Self = Context.Service()("test/LazyEntrypointSelf");
  for (const [kind, value] of [
    ["effect", Effect.succeed({ answer: 42 })],
    ["layer", Layer.succeed(Self, { answer: 42 })],
  ] as const) {
    let loads = 0;
    const layer = makeEntrypointLayer(
      Self,
      lazyEntrypoint(async () => {
        loads++;
        return { default: value };
      }),
    );
    assert.equal(loads, 0, `${kind}: nothing loads before the build`);
    const self = await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          return yield* Self;
        }),
        layer,
      ),
    );
    assert.equal(self.answer, 42, kind);
    assert.equal(loads, 1, kind);
  }
});

test("a lazy entrypoint whose module fails to load fails its build instead of starting", async () => {
  const Self = Context.Service()("test/LazyEntrypointFailure");
  const layer = makeEntrypointLayer(
    Self,
    lazyEntrypoint(() => Promise.reject(new Error("module failed to evaluate"))),
  );
  await assert.rejects(
    Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          return yield* Self;
        }),
        layer,
      ),
    ),
    /module failed to evaluate/,
  );
});
