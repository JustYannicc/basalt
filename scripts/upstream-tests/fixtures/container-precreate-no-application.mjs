import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as Layer from "effect/Layer";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as HttpClient from "effect/http/HttpClient";
import * as Response from "effect/http/HttpClientResponse";
import * as Redacted from "effect/Redacted";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Credentials } from "@distilled.cloud/cloudflare/Credentials";

// alchemy-run/alchemy#3265's two scenarios at this test's level: a Worker and a Container in one
// dependency cycle, where the Worker binds the application id and the Container attaches to the
// Worker's namespace. A cycle's first deploy, and a deployed Worker gaining a Container-backed
// class (production on 22 Nov), must each create the application exactly once, attached, and
// delete nothing.
const load = (name) =>
  import(
    new URL(
      `${process.env.ALCHEMY_PRECREATE_FIXTURE ?? "../../../node_modules/alchemy/"}src/${name}.ts`,
      import.meta.url,
    )
  );
const { LiveContainerProvider } = await load("Cloudflare/Containers/ContainerProvider");
const { CloudflareEnvironment } = await load("Cloudflare/CloudflareEnvironment");
const { AlchemyContext } = await load("AlchemyContext");
const { Docker } = await load("Docker/Docker");
const { Resource } = await load("Resource");
const Provider = await load("Provider");
const Stack = await load("Stack");
const Plan = await load("Plan");
const { apply } = await load("Apply");
const { State, InMemoryService } = await load("State/index");
const { Stage } = await load("Stage");
const { provideFreshArtifactStore } = await load("Artifacts");
const Container = Resource("Cloudflare.Container");
const Worker = Resource("Fixture.Worker");
globalThis.fetch = () => {
  throw new Error("Real network access is forbidden in this provider regression");
};

const digest = `sha256:${"a".repeat(64)}`;
const reference = `registry.cloudflare.com/fixture/fixture-cell@${digest}`;
let live, calls, deployed;
const reset = () => {
  live = new Map();
  calls = { create: 0, delete: 0 };
  // The Worker's live classes: a deployed Worker's precreate reuses its live script, so a class it
  // gains has no namespace until its own reconcile uploads it.
  deployed = undefined;
};
let next = 1;
// The Worker's upload lands after the Container's reconcile has started, as on production: the
// Container reads the namespace before the Worker publishes it. Its reconcile's first list of
// applications is the signal.
let applying = false;
let containerReconciling;
const reconcileStarted = () => {
  let resolve;
  const promise = new Promise((done) => (resolve = done));
  containerReconciling = { promise, resolve };
};
const answer = (request, status, body) =>
  Effect.succeed(Response.fromWeb(request, globalThis.Response.json(body, { status })));
const ok = (request, result) =>
  answer(request, 200, { success: true, errors: [], messages: [], result });
const http = HttpClient.make((request, url) => {
  if (url.hostname === "registry.cloudflare.com")
    return Effect.succeed(
      Response.fromWeb(
        request,
        new globalThis.Response(null, {
          status: 200,
          headers: { "docker-content-digest": digest },
        }),
      ),
    );
  if (url.pathname.endsWith("/credentials"))
    return ok(request, {
      account_id: "fixture",
      registry_host: "registry.cloudflare.com",
      username: "v1",
      password: "synthetic-never-sent",
    });
  const [, id, rest] = /\/containers\/applications(?:\/([^/]+))?(\/.*)?$/u.exec(url.pathname) ?? [];
  if (rest === "/rollouts") return ok(request, { id: "fixture-rollout" });
  const body =
    request.body?._tag === "Uint8Array"
      ? JSON.parse(Buffer.from(request.body.body).toString())
      : {};
  if (request.method === "GET" && !id) {
    if (applying) containerReconciling.resolve();
    return ok(request, [...live.values()]);
  }
  if (request.method === "GET" || (request.method !== "POST" && !live.has(id)))
    return live.has(id)
      ? ok(request, live.get(id))
      : answer(request, 404, {
          success: false,
          errors: [{ code: 1609, message: "Container application not found" }],
          messages: [],
          result: null,
        });
  if (request.method === "DELETE") {
    calls.delete++;
    live.delete(id);
    return ok(request, null);
  }
  if (request.method === "POST") {
    calls.create++;
    const app = { ...body, id: `app-${next++}`, account_id: "fixture", version: 1 };
    live.set(app.id, app);
    return ok(request, app);
  }
  const app = { ...live.get(id), ...body, version: live.get(id).version + 1 };
  live.set(id, app);
  return ok(request, app);
});

const namespaces = (classes = []) =>
  Object.fromEntries(classes.map((name) => [name, `namespace-${name}`]));
const providers = Layer.mergeAll(
  LiveContainerProvider(),
  Provider.succeed(Worker, {
    stables: ["id"],
    // A new Worker's precreate uploads a placeholder with every class; a deployed one reuses its
    // live script, whose classes are those its last reconcile uploaded.
    precreate: ({ id, news }) =>
      Effect.succeed({ id, namespaces: deployed ?? namespaces(news?.classes) }),
    reconcile: ({ id, news }) =>
      Effect.promise(() =>
        news.classes.includes("Cell") ? containerReconciling.promise : Promise.resolve(),
      ).pipe(
        Effect.andThen(
          Effect.sync(() => {
            deployed = namespaces(news.classes);
            return { id, ...news, namespaces: deployed };
          }),
        ),
      ),
    delete: () => Effect.void,
  }),
);
const withCell = Effect.gen(function* () {
  const cell = yield* Container("Cell", {
    name: "fixture-cell",
    image: reference,
    className: "Cell",
    instanceType: "basic",
  });
  const worker = yield* Worker("PoolWorker", {
    classes: ["Cell"],
    CELL_APPLICATION_ID: cell.applicationId,
  });
  yield* cell.bind("Worker", { durableObjects: { namespaceId: worker.namespaces.Cell } });
});
const workerAlone = Worker("PoolWorker", { classes: [] });
const context = mkdtempSync(join(tmpdir(), "basalt-container-precreate-"));
const deploy = (program, store) =>
  program.pipe(
    Stack.make({
      name: "precreate",
      providers,
      state: Layer.effect(
        State,
        Effect.sync(() => InMemoryService(store)),
      ),
    }),
    Effect.flatMap((compiled) =>
      Plan.make(compiled).pipe(
        Effect.tap(() =>
          Effect.sync(() => {
            applying = true;
            reconcileStarted();
          }),
        ),
        Effect.flatMap(apply),
        Effect.ensuring(Effect.sync(() => (applying = false))),
        Effect.provide(compiled.services),
      ),
    ),
    Effect.provideService(Stage, "test"),
    provideFreshArtifactStore,
  );
const created = (scenario, exit, store) => {
  assert.ok(Exit.isSuccess(exit), `${scenario}: the deploy converges`);
  const attached = [...live.values()].filter(
    (app) => app.durable_objects?.namespace_id === "namespace-Cell",
  );
  assert.deepEqual(calls, { create: 1, delete: 0 }, `${scenario}: one create, no delete`);
  assert.equal(attached.length, 1, `${scenario}: the one application is attached`);
  assert.equal(store.precreate.test.Cell.attr.applicationId, attached[0].id, `${scenario}: State`);
  // The convergence pass hands the Worker the created application's id, not the placeholder.
  assert.equal(
    store.precreate.test.PoolWorker.attr.CELL_APPLICATION_ID,
    attached[0].id,
    `${scenario}: the Worker holds the application's id`,
  );
};
const run = Effect.gen(function* () {
  reset();
  const first = {};
  created("first deploy", yield* Effect.exit(deploy(withCell, first)), first);
  reset();
  const grown = {};
  yield* deploy(workerAlone, grown);
  calls = { create: 0, delete: 0 };
  created("a deployed Worker gains the class", yield* Effect.exit(deploy(withCell, grown)), grown);
  console.log(JSON.stringify({ scenarios: 2, calls }));
}).pipe(
  Effect.provide(NodeServices.layer),
  Effect.provideService(AlchemyContext, { dotAlchemy: context, dev: false, adopt: false }),
  Effect.provideService(Docker, {
    image: { build: () => Effect.die(new Error("Unexpected Docker build")) },
  }),
  Effect.provideService(HttpClient.HttpClient, http),
  Effect.provideService(CloudflareEnvironment, Effect.succeed({ accountId: "fixture" })),
  Effect.provideService(
    Credentials,
    Effect.succeed({
      type: "apiToken",
      apiToken: Redacted.make("synthetic-never-sent"),
      apiBaseUrl: "https://fixture.invalid",
    }),
  ),
  Effect.scoped,
);
try {
  await Effect.runPromise(run);
} finally {
  rmSync(context, { recursive: true, force: true });
}
