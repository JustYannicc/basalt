import assert from "node:assert/strict";
import { Deferred, Effect, Layer } from "effect";

// Real Plan and Apply from the installed tree; only the providers are synthetic, and every
// reconcile counts as an upload.
const [tree = "lib", scenario] = process.argv.slice(2);
assert.ok(tree === "src" || tree === "lib");
const load = (name) =>
  import(
    new URL(
      `../../../node_modules/alchemy/${tree}/${name}.${tree === "src" ? "ts" : "js"}`,
      import.meta.url,
    )
  );
const Apply = await load("Apply");
const Plan = await load("Plan");
const Provider = await load("Provider");
const { isResolved } = await load("Diff");
const { Resource } = await load("Resource");
const { Stack } = await load("Stack");
const { Stage } = await load("Stage");
const { State } = await load("State/State");
const { InMemoryService } = await load("State/InMemoryState");

const name = "fixture";
const Thing = Resource("Fixture.Thing");
const Container = Resource("Fixture.Container");

const declare = (body) =>
  Effect.gen(function* () {
    const stack = { name, stage: name, resources: {}, bindings: {}, actions: {} };
    yield* body.pipe(Effect.provideService(Stack, stack));
    return { ...stack, output: {} };
  });

const changes = (plan) =>
  Object.values(plan.resources)
    .filter((node) => node.action !== "noop")
    .map((node) => `${node.resource.FQN}:${node.action}`)
    .sort();

const counts = (fqns) => {
  const count = {};
  for (const fqn of [...fqns].sort()) count[fqn] = (count[fqn] ?? 0) + 1;
  return count;
};

/** Plans, and applies, each declared stack in turn against one state. */
const deployments = (providers) => {
  const memory = InMemoryService();
  const run = (program, stack) =>
    program.pipe(
      Effect.provideService(State, memory),
      Effect.provideService(Stack, stack),
      Effect.provideService(Stage, stack.stage),
      Effect.provide(providers),
    );
  return {
    apply: (stack) =>
      run(
        Effect.flatMap(Plan.make(stack), (plan) =>
          Effect.as(Apply.apply(plan), changes(plan)),
        ),
        stack,
      ),
    plan: (stack) => run(Effect.map(Plan.make(stack), changes), stack),
    recorded: (fqn) => Effect.flatMap(memory, (state) => state.get({ stack: name, stage: name, fqn })),
  };
};

/**
 * Two dependency cycles, as in the release stack: the pool Worker and its container name each
 * other, the tools Worker and its peer name each other, and the pool Worker reads the tools
 * Worker's attributes. Each release uploads the pool Worker once, with the tools Worker's new
 * attributes, not first with the old ones (or a precreated stub) and again to converge.
 */
const crossCycle = Effect.gen(function* () {
  let uploads, poolReads, poolUploading;
  const providers = Provider.succeed(Thing, {
    precreate: ({ fqn }) => Effect.sync(() => ({ name: `name-${fqn}`, value: "precreated" })),
    reconcile: ({ fqn, news }) =>
      Effect.gen(function* () {
        uploads.push(fqn);
        if (fqn === "PoolWorker") {
          poolReads.push(news.tools);
          yield* Deferred.succeed(poolUploading, undefined);
        }
        // An upload takes time. The tools Worker's ends once the pool Worker's starts, or after a
        // while when the pool Worker waits for it, so a pool Worker that does not wait reads the
        // tools Worker's attributes from before its upload.
        if (fqn === "Api")
          yield* Effect.race(Deferred.await(poolUploading), Effect.sleep("250 millis"));
        return { name: `name-${fqn}`, value: JSON.stringify(news) };
      }),
    delete: () => Effect.void,
  });
  const stack = (release) =>
    declare(
      Effect.gen(function* () {
        const tools = yield* Thing("Api", { release });
        const toolsPeer = yield* Thing("ApiPeer", { peer: tools.name });
        yield* tools.bind("peer", { peer: toolsPeer.name });
        const pool = yield* Thing("PoolWorker", { tools: tools.value });
        const container = yield* Thing("PoolContainer", { worker: pool.name });
        yield* pool.bind("container", { container: container.name });
      }),
    );
  const { apply, plan } = deployments(providers);
  for (const release of ["one", "two"]) {
    uploads = [];
    poolReads = [];
    poolUploading = Deferred.makeUnsafe();
    const rows = yield* apply(yield* stack(release));
    assert.ok(rows.includes(`PoolWorker:${release === "one" ? "create" : "update"}`));
    assert.deepEqual(
      counts(uploads),
      { Api: 1, ApiPeer: 1, PoolContainer: 1, PoolWorker: 1 },
      `release ${release} uploads every resource once`,
    );
    assert.deepEqual(
      poolReads,
      [JSON.stringify({ release })],
      `release ${release} uploads the pool Worker with the tools Worker's new attributes`,
    );
  }
  assert.deepEqual(yield* plan(yield* stack("two")), [], "the release has converged");
});

/**
 * A Worker binds its container's image hash, and the container's diff can only check that hash
 * once the cycle's bindings resolve. When the container's reconcile records a new hash, the
 * planner had already handed the Worker the recorded one, so the plan after the release may
 * update the Worker to read the new hash. That read-back converges: the plan after it is empty.
 */
const readBack = Effect.gen(function* () {
  let uploads = [];
  let imageHash = "image-one";
  const providers = Layer.mergeAll(
    Provider.succeed(Thing, {
      precreate: ({ fqn }) => Effect.sync(() => ({ name: `name-${fqn}`, namespace: "pending" })),
      reconcile: ({ fqn }) =>
        Effect.sync(() => {
          uploads.push(fqn);
          return { name: `name-${fqn}`, namespace: `namespace-${fqn}` };
        }),
      delete: () => Effect.void,
    }),
    Provider.succeed(Container, {
      stables: ["applicationId"],
      // As the installed container provider does for an image source: nothing is known while the
      // cycle's bindings are unresolved, and a recorded hash that differs is an update.
      diff: ({ output, newBindings }) =>
        Effect.succeed(
          isResolved(newBindings) && output?.hash?.image !== imageHash
            ? { action: "update" }
            : undefined,
        ),
      precreate: () => Effect.sync(() => ({ applicationId: "app", hash: { image: "pending" } })),
      reconcile: ({ fqn }) =>
        Effect.sync(() => {
          uploads.push(fqn);
          return { applicationId: "app", hash: { image: imageHash } };
        }),
      delete: () => Effect.void,
    }),
  );
  const stack = (release) =>
    declare(
      Effect.gen(function* () {
        const worker = yield* Thing("PoolWorker", { release });
        const container = yield* Container("PoolContainer", { image: "pinned" });
        yield* container.bind("namespace", { namespace: worker.namespace });
        yield* worker.bind("container", { hash: container.hash });
      }),
    );
  const { apply, plan, recorded } = deployments(providers);
  yield* apply(yield* stack("one"));
  imageHash = "image-two";
  uploads = [];
  yield* apply(yield* stack("two"));
  assert.deepEqual(counts(uploads), { PoolContainer: 1, PoolWorker: 1 });
  const after = yield* plan(yield* stack("two"));
  assert.ok(
    after.every((row) => row === "PoolWorker:update"),
    "only the Worker reads the container's new hash after the release",
  );
  uploads = [];
  yield* apply(yield* stack("two"));
  assert.deepEqual(counts(uploads), after.length > 0 ? { PoolWorker: 1 } : {});
  assert.match(JSON.stringify((yield* recorded("PoolWorker")).bindings), /image-two/);
  assert.deepEqual(yield* plan(yield* stack("two")), [], "the read-back converges");
});

await Effect.runPromise({ "cross-cycle": crossCycle, "read-back": readBack }[scenario]);
