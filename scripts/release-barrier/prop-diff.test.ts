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
import { reportRefusal } from "./refusal-report.ts";
import { withReleaseRuntime } from "./runtime.ts";

interface FixtureContainer extends Resource<
  "Cloudflare.Container",
  {
    hash: { image: string };
    env: { ACCESS_TOKEN: string };
    name?: string;
    apiKeys?: Record<string, number>;
  },
  { applicationId: string }
> {}
const FixtureContainer = Resource<FixtureContainer>("Cloudflare.Container");
const oldHash = "a".repeat(16);
const newHash = "b".repeat(16);

function containerPlan(
  change: "image" | "env" | "noop" | "interrupted" | "key" | "key-map" | "multiple",
  primary = "UnsupportedContainer",
) {
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
      for (const id of change === "multiple" ? [primary, "OtherContainer"] : [primary]) {
        yield* FixtureContainer(id, {
          hash: { image: newHash },
          env: { ACCESS_TOKEN: "new-private-value" },
          ...(change === "key" ? { name: "ASIA1234567890ABCDEF" } : {}),
          ...(change === "key-map" ? { apiKeys: { Abcdefghij1234567890: 2 } } : {}),
        });
      }
    }),
  );
  return Effect.runPromise(
    evalStack(
      stack,
      (compiled) =>
        Effect.gen(function* () {
          yield* Apply.apply(yield* Plan.make(compiled));
          const state = yield* yield* State;
          for (const fqn of change === "multiple" ? [primary, "OtherContainer"] : [primary]) {
            const key = { stack: compiled.name, stage: compiled.stage, fqn };
            const saved = yield* state.get(key);
            assert.ok(saved?.status === "created" || saved?.status === "updated");
            const props = {
              hash: {
                image:
                  change === "image" ||
                  change === "interrupted" ||
                  (change === "multiple" && fqn === primary)
                    ? oldHash
                    : newHash,
              },
              env: {
                ACCESS_TOKEN:
                  change === "env" || (change === "multiple" && fqn === "OtherContainer")
                    ? "old-private-value"
                    : "new-private-value",
              },
              ...(change === "key" ? { name: "AKIA1234567890ABCDEF" } : {}),
              ...(change === "key-map" ? { apiKeys: { Abcdefghij1234567890: 1 } } : {}),
            };
            yield* state.set({
              ...key,
              value:
                change === "interrupted"
                  ? { ...saved, status: "updating", old: { props, attr: saved.attr, bindings: [] } }
                  : { ...saved, props },
            });
          }
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
    assert.equal(error?.reason, "unsupported-container");
    assert.deepEqual(error?.delta, {
      fqn: "UnsupportedContainer",
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

test("the existing pool image update passes plan admission for staged validation", async () => {
  assert.equal(await containerPlan("image", "PoolContainer"), undefined);
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
  const image = "registry.cloudflare.com/" + "public/".repeat(35) + "pool:latest";
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

test("AWS-style keys cannot reach refusal or failure.json scalar values", async (context) => {
  const error = await containerPlan("key");
  assert.deepEqual(error?.delta?.changed, [{ path: "name", changed: true }]);
  const directory = await mkdtemp(join(tmpdir(), "barrier-diff-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  await releaseEvidence(directory, "a".repeat(40)).failure(error);
  const text = await readFile(join(directory, "failure.json"), "utf8");
  assert.deepEqual(JSON.parse(text).delta, error?.delta);
  assert.ok(!/AKIA|ASIA/.test(text));
});

test("dynamic credential keys and private hostnames stay out of public diffs", () => {
  const old = {
    credentials: { abcdefghijklmnopqrstuvwx: 1 },
    name: "build-one.preview.example",
    hash: { input: "build-one.preview.example" },
    image: "private.registry.example/pool:old",
  };
  const next = {
    credentials: { abcdefghijklmnopqrstuvwx: 2 },
    name: "build-two.preview.example",
    hash: { input: "build-two.preview.example" },
    image: "private.registry.example/pool:new",
  };
  assert.deepEqual(changedProps(old, next), [
    { path: "credentials.[changed]", changed: true },
    { path: "hash.input", changed: true },
    { path: "image", changed: true },
    { path: "name", changed: true },
  ]);
});

test("an opaque image tag cannot bypass token redaction", () => {
  assert.deepEqual(
    changedProps({ image: "pool:old" }, { image: "pool:abcdefghijklmnopqrstuvwx" }),
    [{ path: "image", changed: true }],
  );
});

test("short credential map keys cannot reach refusal or failure.json paths", async (context) => {
  const error = await containerPlan("key-map");
  assert.deepEqual(error?.delta?.changed, [{ path: "apiKeys.[changed]", changed: true }]);
  const directory = await mkdtemp(join(tmpdir(), "barrier-diff-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  await releaseEvidence(directory, "a".repeat(40)).failure(error);
  const text = await readFile(join(directory, "failure.json"), "utf8");
  assert.deepEqual(JSON.parse(text).delta, error?.delta);
  assert.ok(!text.includes("Abcdefghij1234567890"));
});

test("masking a private ancestor keeps its descendants private", () => {
  assert.deepEqual(
    changedProps(
      { extended_credentials_map_name: { name: "alice" } },
      { extended_credentials_map_name: { name: "bob" } },
    ),
    [{ path: "[changed].name", changed: true }],
  );
});

test("one refusal receipt reports both blocked nodes and keeps each delta redacted", async (context) => {
  const error = await containerPlan("multiple");
  const expected = [
    {
      reason: "unsupported-container",
      fqn: "OtherContainer",
      type: "Cloudflare.Container",
      changed: [{ path: "env.ACCESS_TOKEN", changed: true }],
    },
    {
      reason: "unsupported-container",
      fqn: "UnsupportedContainer",
      type: "Cloudflare.Container",
      changed: [{ path: "hash.image", old: oldHash, new: newHash }],
    },
  ];
  const refusals = error?.refusals;
  assert.equal(refusals?.length, 2);
  assert.deepEqual(
    [...(refusals ?? [])].sort((a, b) =>
      ("fqn" in a ? a.fqn : "").localeCompare("fqn" in b ? b.fqn : ""),
    ),
    expected,
  );
  const directory = await mkdtemp(join(tmpdir(), "barrier-diff-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  await releaseEvidence(directory, "a".repeat(40)).failure(error);
  const text = await readFile(join(directory, "failure.json"), "utf8");
  const failure = JSON.parse(text);
  assert.deepEqual(failure.refusals, refusals);
  const summaryPath = join(directory, "summary.md");
  const errors: string[] = [];
  await reportRefusal(failure, summaryPath, (message) => {
    errors.push(message);
  });
  const summary = await readFile(summaryPath, "utf8");
  for (const output of [text, summary, ...errors]) {
    assert.ok(output.includes("OtherContainer"));
    assert.ok(output.includes("UnsupportedContainer"));
    assert.ok(!output.includes("private-value"));
    assert.ok(output.includes("env.ACCESS_TOKEN"));
    assert.ok(output.includes(oldHash));
    assert.ok(output.includes(newHash));
  }
  assert.ok(errors.some((message) => message.startsWith("::error ")));
});
