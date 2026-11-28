import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Credentials } from "@distilled.cloud/cloudflare/Credentials";
import { Clock, Context, Effect, Layer, Redacted } from "effect";
import { HttpClient, HttpClientResponse } from "effect/http";
import { envelope, resolvedApplication } from "../../pool-fleet/test/cloudflare-shapes.ts";
import {
  listPage,
  refusalBody,
  registryCredentials,
} from "../../stage-cloudflare/test/cloudflare-shapes.mjs";
import {
  ChangesRemainAfterApply,
  providerReasons,
  remainingRows,
  type Snapshot,
} from "../../release/plan-summary.ts";
import { virtualClock } from "./virtual-clock.ts";

// The Container provider's diff names each bare update by one word of a closed set. Each case here
// deploys a Container through the installed Alchemy tree, changes the one thing its branch reads,
// plans again, and reads the release read-back line that plan would fail with: it must say the
// branch's word, and the planner must carry the word onto the Update node.

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
type Node = {
  readonly action: string;
  readonly providerReason?: unknown;
  readonly resource: { readonly Type: string };
  readonly bindings?: readonly { readonly sid?: string; readonly action: string }[];
};
type Planned = { readonly resources: Record<string, Node>; readonly deletions: object };
type Compiled = { readonly services: Context.Context<never> };
type Attr = {
  applicationId: string;
  hash: { image?: string; digest?: string };
  dev?: unknown;
};
type Store = Record<string, Record<string, Record<string, { attr: Attr }>>>;
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

const digest = (fill: string) => `sha256:${fill.repeat(64)}`;
const published = digest("e");
const imageOf = (sha: string) => `registry.cloudflare.com/fixture/fixture-mock@${sha}`;
let live = new Map<string, { configuration: { image: string } }>();
let next = 1;
const answer = (
  request: Parameters<typeof HttpClientResponse.fromWeb>[0],
  status: number,
  body: unknown,
) =>
  Effect.succeed(HttpClientResponse.fromWeb(request, globalThis.Response.json(body, { status })));
const http = HttpClient.make((request, url) => {
  // Every image input is already published, so a deploy reuses it and never builds.
  if (url.hostname === "registry.cloudflare.com")
    return Effect.succeed(
      HttpClientResponse.fromWeb(
        request,
        new globalThis.Response(null, {
          status: 200,
          headers: { "docker-content-digest": published },
        }),
      ),
    );
  if (url.pathname.endsWith("/credentials")) return answer(request, 200, registryCredentials());
  const [, id, rest] = /\/containers\/applications(?:\/([^/]+))?(\/.*)?$/u.exec(url.pathname) ?? [];
  if (request.method === "GET" && !id && !rest)
    return answer(request, 200, listPage([...live.values()]));
  if (request.method === "GET" && id && !rest) {
    const found = live.get(id);
    return found
      ? answer(request, 200, envelope(found))
      : answer(
          request,
          404,
          refusalBody([{ code: 1609, message: "Container application not found" }]),
        );
  }
  if (request.method === "POST" && !id) {
    const created = {
      ...resolvedApplication,
      id: `app-${next++}`,
      name: "fixture-mock",
      account_id: "fixture",
      max_instances: 1,
      configuration: { ...resolvedApplication.configuration, image: imageOf(published) },
      durable_objects: { namespace_id: "namespace-mock" },
    };
    live.set(created.id, created);
    return answer(request, 200, envelope(created));
  }
  return Effect.die(new Error(`Unexpected ${request.method} ${url.pathname}`));
});

// Each plan resets `slept`; a minute of backoff is far past the provider's readiness window.
const time = virtualClock(60_000);
const contextDirectory = mkdtempSync(join(tmpdir(), "basalt-container-diff-reason-"));
const dockerfile = (text: string) => writeFileSync(join(contextDirectory, "Dockerfile"), text);
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
const mockProps = {
  name: "fixture-mock",
  className: "Mock",
  context: contextDirectory,
  schedulingPolicy: "default",
  instanceType: "standard-1",
  maxInstances: 1,
  constraints: { jurisdiction: "eu", regions: ["EEUR", "WEUR"] },
  observability: { logs: { enabled: true } },
};
// A Container alone, and the Worker and Container cycle the emulated upstream stage declares.
const alone = Effect.asVoid(Container("Mock", mockProps));
const cycle = Effect.gen(function* () {
  const mock = yield* Container("Mock", mockProps);
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
const compiled = <A>(
  program: Effect.Effect<void, Error>,
  store: Store,
  f: (stack: Compiled) => Effect.Effect<A, Error>,
) =>
  program.pipe(
    alchemy.make({
      name: "reason",
      providers: layers,
      // The State service is itself the Effect that opens the store.
      state: Layer.succeed(alchemy.State, alchemy.InMemoryService(store)),
    }),
    Effect.flatMap((stack) => f(stack).pipe(Effect.provide(stack.services))),
    Effect.provideService(alchemy.Stage, "test"),
    alchemy.provideFreshArtifactStore,
  );

/** The rows the release entry reads from a plan, as `Alchemist.Stack.plan` hands them over. */
const snapshotOf = (planned: Planned): Snapshot =>
  ({
    resources: Object.entries(planned.resources).map(([fqn, node]) => ({
      fqn,
      resourceType: node.resource.Type,
      action: node.action,
      bindings: node.bindings ?? [],
    })),
    summary: {},
    native: planned,
  }) as never;

/**
 * Deploys `program` from scratch, applies `change` to what the deploy left, and plans again: the
 * read-back line that plan fails with, and the Container node's action and reason.
 */
const readBack = (program: Effect.Effect<void, Error>, change: (attr: Attr) => void) =>
  Effect.gen(function* () {
    live = new Map();
    next = 1;
    dockerfile("FROM scratch\n");
    const store: Store = {};
    yield* compiled(program, store, (stack) =>
      alchemy.plan(stack).pipe(Effect.flatMap(alchemy.apply)),
    );
    const attr = store.reason?.test?.Mock?.attr;
    assert.ok(attr && live.has(attr.applicationId), "the deploy creates the application");
    change(attr);
    time.slept = 0;
    const planned = yield* compiled(program, store, (stack) => alchemy.plan(stack));
    const rows = remainingRows(snapshotOf(planned));
    return {
      node: planned.resources.Mock!,
      line: rows.length ? ChangesRemainAfterApply.of(rows).remaining : [],
    };
  });

const cases: ReadonlyArray<
  readonly [word: string, program: Effect.Effect<void, Error>, change: (attr: Attr) => void]
> = [
  // The image input changed while the Worker it points back to is still unresolved.
  ["image-input-unresolved", cycle, () => dockerfile("FROM scratch\nLABEL changed=1\n")],
  ["placeholder-application", alone, (attr) => void (attr.applicationId = "dev:fixture-mock")],
  ["application-not-found", alone, () => live.clear()],
  ["digest-unrecorded", alone, (attr) => void (attr.hash.digest = undefined)],
  [
    "running-digest-differs",
    alone,
    (attr) => void (live.get(attr.applicationId)!.configuration.image = imageOf(digest("f"))),
  ],
  ["image-input-differs", alone, () => dockerfile("FROM scratch\nLABEL changed=1\n")],
  ["dev-differs", alone, (attr) => void (attr.dev = { context: "elsewhere" })],
];

// A resource whose diff answers what the case sets, to pin the planner's copy on its own.
const Reasoned = alchemy.Resource("Fixture.Reasoned");
let reasonedDiff: object | undefined;
const planner = Layer.mergeAll(
  alchemy.succeed(Reasoned, {
    stables: ["id"],
    diff: () => Effect.succeed(reasonedDiff),
    precreate: ({ id }: { id: string }) => Effect.succeed({ id }),
    reconcile: ({ id }: { id: string }) => Effect.succeed({ id }),
    delete: () => Effect.void,
  }),
);
const plannedNode = (diff: object | undefined) =>
  Effect.gen(function* () {
    const store: Store = {};
    const program = Effect.asVoid(Reasoned("Thing", { label: "fixed" }));
    const withStack = <A>(f: (stack: Compiled) => Effect.Effect<A, Error>) =>
      program.pipe(
        alchemy.make({
          name: "planner",
          providers: planner,
          state: Layer.succeed(alchemy.State, alchemy.InMemoryService(store)),
        }),
        Effect.flatMap((stack) => f(stack).pipe(Effect.provide(stack.services))),
        Effect.provideService(alchemy.Stage, "test"),
        alchemy.provideFreshArtifactStore,
      );
    reasonedDiff = undefined;
    yield* withStack((stack) => alchemy.plan(stack).pipe(Effect.flatMap(alchemy.apply)));
    reasonedDiff = diff;
    return (yield* withStack((stack) => alchemy.plan(stack))).resources.Thing!;
  });

const run = Effect.gen(function* () {
  const control = yield* readBack(cycle, () => undefined);
  assert.equal(control.node.action, "noop", "an unchanged deploy plans as noop");
  assert.deepEqual(control.line, []);
  assert.equal("providerReason" in control.node, false, "a noop carries no reason");

  const seen: Record<string, string> = {};
  for (const [word, program, change] of cases) {
    const { node, line } = yield* readBack(program, change);
    assert.equal(node.action, "update", `${word}: the Container still plans an update`);
    assert.equal(node.providerReason, word, `${word}: the Update node carries the branch's word`);
    if (word === "image-input-unresolved") {
      // This branch fires only while the attachment back to the Worker is unresolved, so the row
      // always names that binding and prints as it did before the word existed.
      assert.deepEqual(line, [
        "Mock (Cloudflare.Container update: binding Gateway)",
        "Gateway (Fixture.Worker update: containers)",
      ]);
    } else assert.deepEqual(line, [`Mock (Cloudflare.Container update: provider ${word})`]);
    seen[word] = line[0]!;
  }
  assert.deepEqual(
    Object.keys(seen).sort(),
    [...providerReasons].sort(),
    "every word of the closed set has its case",
  );

  // The planner copies the diff's reason onto the Update node, and adds nothing when there is none.
  const named = yield* plannedNode({ action: "update", reason: "any-word" });
  assert.equal(named.action, "update");
  assert.equal(named.providerReason, "any-word");
  const bare = yield* plannedNode({ action: "update" });
  assert.equal(bare.action, "update");
  assert.equal("providerReason" in bare, false, "a diff without a reason adds no field");
  const computed = yield* plannedNode(undefined);
  assert.equal(computed.action, "noop");
  assert.equal("providerReason" in computed, false);

  return { tree, seen };
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
