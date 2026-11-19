import assert from "node:assert/strict";
import * as Effect from "effect/Effect";
import * as NodeServices from "@effect/platform-node/NodeServices";

// beta.80's wildcard exports name directories; its published runtime files are siblings.
const tree = process.argv[2] ?? "lib";
assert.ok(tree === "src" || tree === "lib");
const load = (name) =>
  import(
    new URL(
      `../../../node_modules/alchemy/${tree}/${name}.${tree === "src" ? "ts" : "js"}`,
      import.meta.url,
    )
  );
const { LiveWorkerProvider } = await load("Cloudflare/Workers/WorkerProvider");
const { Worker } = await load("Cloudflare/Workers/Worker");
const { WorkerBundle } = await load("Cloudflare/Workers/Sources/Rolldown");
const { Stack } = await load("Stack");
const { AlchemyContext } = await load("AlchemyContext");
const { CloudflareLogs } = await load("Cloudflare/Logs");
const { CloudflareEnvironment } = await load("Cloudflare/CloudflareEnvironment");
globalThis.fetch = () => {
  throw new Error("Real network access is forbidden in this provider regression");
};

const hosted = { type: "durable_object_namespace", name: "Hosted", className: "Hosted" };
const elsewhere = {
  type: "durable_object_namespace",
  name: "Elsewhere",
  className: "Elsewhere",
  scriptName: "another-worker",
};
const program = Effect.gen(function* () {
  const provider = yield* Worker.Provider;
  // A changed schedule is an update the provider decides before it reads any source, so the
  // answer shows what it keeps readable for the resources that wait on this Worker.
  const readable = (recorded, declared) =>
    provider
      .diff({
        id: "Fixture",
        fqn: "Fixture",
        olds: { name: "fixture-worker" },
        news: { name: "fixture-worker", crons: ["* * * * *"] },
        output: {
          workerId: "0".repeat(32),
          workerName: "fixture-worker",
          accountId: "fixture",
          crons: [],
          routes: [],
          urls: [],
          durableObjectNamespaces: recorded,
          hash: {},
        },
        newBindings: declared && [{ sid: "fixture", data: { bindings: declared } }],
        oldBindings: [],
      })
      .pipe(
        Effect.map((diff) => {
          assert.equal(diff?.action, "update");
          return diff.stables.includes("durableObjectNamespaces");
        }),
      );
  assert.equal(
    yield* readable({ Hosted: "hosted-id" }, [hosted]),
    true,
    "a Worker's own classes stay readable across an update",
  );
  // The platform returns a namespace id for a binding to another Worker's class as well, and the
  // provider records every binding that has one.
  assert.equal(
    yield* readable({ Hosted: "hosted-id", Elsewhere: "elsewhere-id" }, [hosted, elsewhere]),
    true,
    "a recorded class that another Worker hosts does not hide the Worker's own classes",
  );
  assert.equal(
    yield* readable({ Hosted: "hosted-id", Elsewhere: "elsewhere-id" }, [
      hosted,
      // Inside a dependency cycle the other Worker's name is not known when the plan is made.
      { ...elsewhere, scriptName: {} },
    ]),
    true,
    "the other Worker's name does not have to be known",
  );
  assert.equal(
    yield* readable({ Hosted: "hosted-id", Retired: "retired-id" }, [hosted]),
    true,
    "removing a class leaves the remaining classes readable",
  );
  assert.equal(
    yield* readable({ Elsewhere: "elsewhere-id" }, [hosted, elsewhere]),
    false,
    "a class the Worker starts to host has no recorded namespace yet",
  );
  assert.equal(
    yield* readable({ Hosted: "hosted-id" }, undefined),
    false,
    "bindings that are not known at all promise nothing",
  );
  return { scenarios: 6 };
}).pipe(
  Effect.provide(LiveWorkerProvider()),
  Effect.provideService(WorkerBundle, {}),
  Effect.provideService(Stack, { name: "fixture", stage: "fixture", resources: {}, bindings: {} }),
  Effect.provideService(AlchemyContext, { dotAlchemy: ".alchemy", dev: false, adopt: false }),
  Effect.provideService(CloudflareLogs, {}),
  Effect.provideService(CloudflareEnvironment, Effect.succeed({ accountId: "fixture" })),
  Effect.provide(NodeServices.layer),
);
console.log(JSON.stringify(await Effect.runPromise(program)));
