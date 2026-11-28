import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Credentials } from "@distilled.cloud/cloudflare/Credentials";
import { Clock, Context, Effect, Exit, Layer, Redacted } from "effect";
import { HttpClient, HttpClientResponse } from "effect/http";
import { envelope, resolvedApplication } from "../../pool-fleet/test/cloudflare-shapes.ts";
import {
  listPage,
  refusalBody,
  registryCredentials,
} from "../../stage-cloudflare/test/cloudflare-shapes.mjs";
import { virtualClock } from "./virtual-clock.ts";

// A Worker and a context-built Container in one cycle, as the emulated upstream stage declares
// them, planned again right after the deploy that created the application. Cloudflare can answer a
// just-created application as not found for a moment; the fresh plan must still be all noop, and a
// plan of an application that is really gone must still update it.

/** An Output: only `pipe` with a mapped Output is used here. */
interface Out {
  readonly pipe: (f: (output: Out) => Out) => Out;
}
interface FixtureResource {
  readonly hash: Out;
  readonly dev: Out;
  readonly durableObjectNamespaces: Out;
  readonly bind: (sid: string, data: Record<string, unknown>) => Effect.Effect<void, Error>;
}
type Planned = { readonly resources: Record<string, { readonly action: string }> };
type Compiled = { readonly services: Context.Context<never> };
type Store = Record<string, Record<string, Record<string, { attr: { applicationId: string } }>>>;
/** The part of the installed Alchemy tree this regression drives, loaded from `src` or `lib`. */
interface Alchemy {
  LiveContainerProvider: () => Layer.Layer<never>;
  CloudflareEnvironment: Context.Key<unknown, Effect.Effect<{ accountId: string }>>;
  AlchemyContext: Context.Key<unknown, { dotAlchemy: string; dev: boolean; adopt: boolean }>;
  Docker: Context.Key<unknown, { image: { build: () => Effect.Effect<never> } }>;
  Resource: (type: string) => (id: string, props: object) => Effect.Effect<FixtureResource, Error>;
  map: (f: (value: Record<string, string> | undefined) => unknown) => (output: Out) => Out;
  succeed: (resource: unknown, service: Record<string, unknown>) => Layer.Layer<never>;
  make: (options: {
    name: string;
    providers: Layer.Layer<never>;
    state: Layer.Layer<never>;
  }) => (program: Effect.Effect<void, Error>) => Effect.Effect<Compiled, Error>;
  plan: (compiled: Compiled) => Effect.Effect<Planned, Error>;
  apply: (plan: Planned) => Effect.Effect<unknown, Error>;
  State: Context.Key<unknown, unknown>;
  InMemoryService: (store: Store) => Effect.Effect<unknown>;
  Stage: Context.Key<unknown, string>;
  provideFreshArtifactStore: <A, E>(effect: Effect.Effect<A, E>) => Effect.Effect<A, E>;
}

// beta.80's wildcard exports name directories; its published runtime files are siblings.
const tree = process.argv[2] ?? "lib";
assert.ok(tree === "src" || tree === "lib");
const base = process.env.ALCHEMY_READBACK_FIXTURE ?? "../../../node_modules/alchemy/";
const load = (name: string): Promise<Record<string, unknown>> =>
  import(new URL(`${base}${tree}/${name}.${tree === "src" ? "ts" : "js"}`, import.meta.url).href);
const modules = await Promise.all(
  [
    "Cloudflare/Containers/ContainerProvider",
    "Cloudflare/CloudflareEnvironment",
    "AlchemyContext",
    "Docker/Docker",
    "Resource",
    "Output",
    "Provider",
    "Stack",
    "Plan",
    "Apply",
    "State/index",
    "Stage",
    "Artifacts",
  ].map(load),
);
const [provider, environment, context, docker, resource, output, providers, stack, plan] = modules;
const [applied, state, stage, artifacts] = modules.slice(9);
// Each name from the one module that defines it: several modules re-export the same services.
const alchemy = {
  LiveContainerProvider: provider!.LiveContainerProvider,
  CloudflareEnvironment: environment!.CloudflareEnvironment,
  AlchemyContext: context!.AlchemyContext,
  Docker: docker!.Docker,
  Resource: resource!.Resource,
  map: output!.map,
  succeed: providers!.succeed,
  make: stack!.make,
  plan: plan!.make,
  apply: applied!.apply,
  State: state!.State,
  InMemoryService: state!.InMemoryService,
  Stage: stage!.Stage,
  provideFreshArtifactStore: artifacts!.provideFreshArtifactStore,
} as unknown as Alchemy;
const Container = alchemy.Resource("Cloudflare.Container");
const Worker = alchemy.Resource("Fixture.Worker");
globalThis.fetch = () => {
  throw new Error("Real network access is forbidden in this provider regression");
};

const digest = `sha256:${"e".repeat(64)}`;
// Reads of a new application's id that answer not found, counted from its create.
const NOT_FOUND_READS = 3;
let live = new Map<string, object>();
let misses = new Map<string, number>();
// Ids whose read fails with something other than not found.
let broken = new Set<string>();
let reads = { byId: 0, notFound: 0 };
let creates: { attached: unknown }[] = [];
let next = 1;
const reset = () => {
  live = new Map();
  misses = new Map();
  broken = new Set();
  reads = { byId: 0, notFound: 0 };
  creates = [];
  next = 1;
};
const answer = (
  request: Parameters<typeof HttpClientResponse.fromWeb>[0],
  status: number,
  body: unknown,
) =>
  Effect.succeed(HttpClientResponse.fromWeb(request, globalThis.Response.json(body, { status })));
const http = HttpClient.make((request, url) => {
  // The image is already published under its input hash, so the deploy reuses it.
  if (url.hostname === "registry.cloudflare.com")
    return Effect.succeed(
      HttpClientResponse.fromWeb(
        request,
        new globalThis.Response(null, {
          status: 200,
          headers: { "docker-content-digest": digest },
        }),
      ),
    );
  if (url.pathname.endsWith("/credentials")) return answer(request, 200, registryCredentials());
  const [, id, rest] = /\/containers\/applications(?:\/([^/]+))?(\/.*)?$/u.exec(url.pathname) ?? [];
  const notFound = () =>
    answer(request, 404, refusalBody([{ code: 1609, message: "Container application not found" }]));
  if (request.method === "GET" && !id && !rest)
    return answer(request, 200, listPage([...live.values()]));
  if (request.method === "GET" && id && !rest) {
    reads.byId++;
    if (broken.has(id))
      return answer(request, 500, refusalBody([{ code: 10000, message: "Internal error" }]));
    if ((misses.get(id) ?? 0) > 0) {
      misses.set(id, (misses.get(id) ?? 0) - 1);
      reads.notFound++;
      return notFound();
    }
    const found = live.get(id);
    return found ? answer(request, 200, envelope(found)) : notFound();
  }
  if (request.method === "POST" && !id) {
    const call: { attached: unknown } = { attached: undefined };
    if (request.body._tag === "Uint8Array")
      call.attached = JSON.parse(
        Buffer.from(request.body.body).toString(),
      ).durable_objects?.namespace_id;
    creates.push(call);
    // What Cloudflare stores for this declaration, from the recorded read of an application.
    const created = {
      ...resolvedApplication,
      id: `app-${next++}`,
      name: "fixture-mock",
      account_id: "fixture",
      max_instances: 1,
      configuration: {
        ...resolvedApplication.configuration,
        image: `registry.cloudflare.com/fixture/fixture-mock@${digest}`,
      },
      durable_objects: { namespace_id: "namespace-mock" },
    };
    live.set(created.id, created);
    misses.set(created.id, NOT_FOUND_READS);
    return answer(request, 200, envelope(created));
  }
  return Effect.die(new Error(`Unexpected ${request.method} ${url.pathname}`));
});

// Each plan resets `slept`; a minute of backoff is far past the provider's readiness window.
const time = virtualClock(60_000);
const contextDirectory = mkdtempSync(join(tmpdir(), "basalt-container-readback-"));
writeFileSync(join(contextDirectory, "Dockerfile"), "FROM scratch\n");
const namespaces = { Mock: "namespace-mock" };
const layers = Layer.mergeAll(
  alchemy.LiveContainerProvider(),
  alchemy.succeed(Worker, {
    stables: ["id"],
    precreate: ({ id }: { id: string }) =>
      Effect.succeed({ id, durableObjectNamespaces: namespaces }),
    reconcile: ({ id, news }: { id: string; news: object }) =>
      Effect.succeed({ id, ...news, durableObjectNamespaces: namespaces }),
    delete: () => Effect.void,
  }),
);
const program = Effect.gen(function* () {
  const mock = yield* Container("Mock", {
    name: "fixture-mock",
    className: "Mock",
    context: contextDirectory,
    schedulingPolicy: "default",
    instanceType: "standard-1",
    maxInstances: 1,
    constraints: { jurisdiction: "eu", regions: ["EEUR", "WEUR"] },
    observability: { logs: { enabled: true } },
  });
  // What an async Worker's `env: { Mock: mock }` binds: the class's container and its namespace.
  const worker = yield* Worker("Gateway", {
    containers: [
      {
        className: "Mock",
        dev: mock.dev,
        hash: mock.hash.pipe(alchemy.map((hash) => hash?.image)),
      },
    ],
  });
  yield* mock.bind("Gateway", {
    durableObjects: {
      namespaceId: worker.durableObjectNamespaces.pipe(alchemy.map((names) => names?.Mock)),
    },
  });
});
const compiled = <A>(store: Store, f: (stack: Compiled) => Effect.Effect<A, Error>) =>
  program.pipe(
    alchemy.make({
      name: "readback",
      providers: layers,
      // The State service is itself the Effect that opens the store.
      state: Layer.succeed(alchemy.State, alchemy.InMemoryService(store)),
    }),
    Effect.flatMap((stack) => f(stack).pipe(Effect.provide(stack.services))),
    Effect.provideService(alchemy.Stage, "test"),
    alchemy.provideFreshArtifactStore,
  );
const actions = (planned: Planned) =>
  Object.fromEntries(Object.entries(planned.resources).map(([fqn, node]) => [fqn, node.action]));
const planOf = (store: Store) =>
  compiled(store, (stack) => alchemy.plan(stack).pipe(Effect.map(actions)));
const deploy = (store: Store) =>
  compiled(store, (stack) => alchemy.plan(stack).pipe(Effect.flatMap(alchemy.apply)));

const run = Effect.gen(function* () {
  reset();
  const created: Store = {};
  yield* deploy(created);
  assert.equal(live.size, 1, "the deploy creates the application");
  assert.deepEqual(
    creates,
    [{ attached: "namespace-mock" }],
    "one create, attached to the namespace",
  );
  assert.equal(created.readback?.test?.Mock?.attr.applicationId, [...live.keys()][0]);
  time.slept = 0;
  const appId = [...live.keys()][0]!;
  // The window is still open when the plan starts, so the plan itself must read through it.
  const pending = misses.get(appId) ?? 0;
  assert.ok(pending > 0, "the application still reads as not found when the plan starts");
  assert.deepEqual(
    yield* planOf(created),
    { Mock: "noop", Gateway: "noop" },
    "a fresh plan right after the create is all noop while the application still reads as not found",
  );
  assert.equal(misses.get(appId), 0, "the plan read through the not-found window");
  const settled = { slept: time.slept, reads: reads.byId };

  reset();
  const deleted: Store = {};
  yield* deploy(deleted);
  misses.clear();
  live.clear();
  time.slept = 0;
  const before = reads.byId;
  assert.deepEqual(
    yield* planOf(deleted),
    { Mock: "update", Gateway: "noop" },
    "an application that is really gone still plans an update once the readiness window has passed",
  );
  assert.ok(
    reads.byId - before > 1,
    "a missing application is read again before it is called gone",
  );
  assert.ok(
    time.slept >= 10_000 && time.slept <= 30_000,
    `the readiness window is waited out once (${time.slept} ms)`,
  );
  const deletedRun = { slept: time.slept, reads: reads.byId - before };

  // Any other failed read is no not-found: the plan fails at once, and nothing waits.
  reset();
  const failing: Store = {};
  yield* deploy(failing);
  misses.clear();
  for (const id of live.keys()) broken.add(id);
  time.slept = 0;
  const outcome = yield* Effect.exit(planOf(failing));
  assert.ok(Exit.isFailure(outcome), "a read that fails another way fails the plan");
  assert.equal(time.slept, 0, "and the plan does not wait for it");

  return { tree, settled, deleted: deletedRun, failing: { slept: time.slept } };
}).pipe(
  Effect.provide(NodeServices.layer),
  Effect.provideService(Clock.Clock, time.clock),
  Effect.provideService(alchemy.AlchemyContext, {
    dotAlchemy: contextDirectory,
    dev: false,
    adopt: false,
  }),
  Effect.provideService(alchemy.Docker, {
    image: { build: () => Effect.die(new Error("Unexpected Docker build")) },
  }),
  Effect.provideService(HttpClient.HttpClient, http),
  Effect.provideService(alchemy.CloudflareEnvironment, Effect.succeed({ accountId: "fixture" })),
  Effect.provideService(
    Credentials,
    Effect.succeed({
      type: "apiToken" as const,
      apiToken: Redacted.make("synthetic-never-sent"),
      apiBaseUrl: "https://fixture.invalid",
    }),
  ),
  Effect.scoped,
);
try {
  console.log(JSON.stringify(await Effect.runPromise(run)));
} finally {
  rmSync(contextDirectory, { recursive: true, force: true });
}
