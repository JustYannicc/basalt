import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Stack, evalStack } from "alchemy/Stack";
import * as Apply from "alchemy/Apply";
import * as Plan from "alchemy/Plan";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import { State } from "alchemy/State/State";
import { InMemoryService } from "alchemy/State/InMemoryState";
import { Effect, Layer, Redacted } from "effect";
import { assertSupportedPlan } from "./alchemy-plan.ts";
import { BarrierRefusal } from "./manifest.ts";
import { changedProps } from "./prop-diff.ts";
import { releaseEvidence } from "./evidence.ts";
import { withReleaseRuntime } from "./runtime.ts";

interface FixtureContainer extends Resource<
  "Cloudflare.Container",
  { hash: { image: string }; env: { ACCESS_TOKEN: string } },
  { applicationId: string }
> {}
const FixtureContainer = Resource<FixtureContainer>("Cloudflare.Container");
const oldHash = "a".repeat(16);
const newHash = "b".repeat(16);

function containerPlan(change: "image" | "env" | "noop" | "interrupted") {
  let action: "update" | "noop" = "update";
  const stack = Stack(
    "fixture",
    {
      providers: Provider.succeed(FixtureContainer, {
        diff: () => Effect.succeed({ action }),
        reconcile: () => Effect.succeed({ applicationId: "container" }),
        delete: () => Effect.void,
      }),
      state: Layer.effect(State, Effect.map(InMemoryService(), Effect.succeed)),
    },
    Effect.gen(function* () {
      yield* FixtureContainer("PoolContainer", {
        hash: { image: newHash },
        env: { ACCESS_TOKEN: "new-private-value" },
      });
    }),
  );
  return Effect.runPromise(
    evalStack(
      stack,
      (compiled) =>
        Effect.gen(function* () {
          yield* Apply.apply(yield* Plan.make(compiled));
          const state = yield* yield* State;
          const key = { stack: compiled.name, stage: compiled.stage, fqn: "PoolContainer" };
          const saved = yield* state.get(key);
          assert.ok(saved?.status === "created" || saved?.status === "updated");
          const props = {
            hash: { image: change === "image" || change === "interrupted" ? oldHash : newHash },
            env: { ACCESS_TOKEN: change === "env" ? "old-private-value" : "new-private-value" },
          };
          yield* state.set({
            ...key,
            value:
              change === "interrupted"
                ? { ...saved, status: "updating", old: { props, attr: saved.attr, bindings: [] } }
                : { ...saved, props },
          });
          action = change === "noop" ? "noop" : "update";
          const plan = yield* Plan.make(compiled);
          try {
            assertSupportedPlan(plan);
            return undefined;
          } catch (error) {
            assert.ok(error instanceof BarrierRefusal);
            return error;
          }
        }).pipe(Effect.provideContext(compiled.services)),
      { stage: "production" },
    ).pipe(withReleaseRuntime),
  );
}

for (const change of ["image", "interrupted"] as const) {
  test(`an ${change} container refusal retains the image prop delta in failure.json`, async (context) => {
    const error = await containerPlan(change);
    assert.equal(error?.reason, "unsupported-resource-update");
    assert.deepEqual(error?.delta, {
      fqn: "PoolContainer",
      type: "Cloudflare.Container",
      changed: [{ path: "hash.image", old: oldHash, new: newHash }],
    });
    const directory = await mkdtemp(join(tmpdir(), "barrier-diff-"));
    context.after(() => rm(directory, { recursive: true, force: true }));
    await releaseEvidence(directory, "a".repeat(40)).failure(error);
    const failure = JSON.parse(await readFile(join(directory, "failure.json"), "utf8"));
    assert.deepEqual(failure.delta, error?.delta);
  });
}

test("a container env refusal names the path without retaining either value", async () => {
  const error = await containerPlan("env");
  assert.deepEqual(error?.delta?.changed, [{ path: "env.ACCESS_TOKEN", changed: true }]);
  assert.ok(!JSON.stringify(error).includes("private-value"));
});

test("an unchanged container still passes the supported plan check", async () => {
  assert.equal(await containerPlan("noop"), undefined);
});

test("public diffs omit credentials, opaque tokens, hosts and arbitrary strings", () => {
  const before = {
    credentials: { name: "old-private-value" },
    bindings: [{ name: "old-private-value" }],
    name: "sk_abcdefghijklmnopqrstuvwxyz012345",
    context: "/private/path/to/context",
    description: "private text",
    password: Redacted.make("old-private-value"),
    version: 1,
  };
  const after = {
    credentials: { name: "new-private-value" },
    bindings: [{ name: "new-private-value" }],
    name: "ghp_abcdefghijklmnopqrstuvwxyz012345",
    context: "/other/private/path",
    description: "different private text",
    password: Redacted.make("new-private-value"),
    version: 2,
  };
  const changes = changedProps(before, after);
  assert.deepEqual(
    changes.filter((item) => "old" in item),
    [{ path: "version", old: 1, new: 2 }],
  );
  assert.equal(changes.length, 7);
  assert.ok(!JSON.stringify(changes).includes("private"));
});

test("safe image refs are capped, numeric additions are retained and removals are explicit", () => {
  const image = "registry.example/" + "public/".repeat(35) + "pool:latest";
  assert.deepEqual(changedProps({ image: "pool:old", count: 2 }, { image, size: 3 }), [
    { path: "count", old: 2, new: null },
    { path: "image", old: "pool:old", new: image.slice(0, 200) },
    { path: "size", old: null, new: 3 },
  ]);
});

test("unresolved expressions retain their path without hiding resolved sibling changes", () => {
  assert.deepEqual(
    changedProps({ version: 1 }, { env: { NAME: Effect.succeed("private") }, version: 2 }),
    [
      { path: "env.NAME", changed: true },
      { path: "version", old: 1, new: 2 },
    ],
  );
});

test("immutable registry digests remain visible while token-shaped names do not", () => {
  const prefix = "registry.cloudflare.com/" + "a".repeat(32) + "/pool@sha256:";
  assert.deepEqual(
    changedProps(
      { image: prefix + "a".repeat(64), name: "a".repeat(64) },
      { image: prefix + "b".repeat(64), name: "b".repeat(64) },
    ),
    [
      { path: "image", old: prefix + "a".repeat(64), new: prefix + "b".repeat(64) },
      { path: "name", changed: true },
    ],
  );
});
