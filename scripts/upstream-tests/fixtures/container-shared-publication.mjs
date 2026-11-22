import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as Layer from "effect/Layer";
import * as Effect from "effect/Effect";
import * as Cause from "effect/Cause";
import * as Exit from "effect/Exit";
import * as HttpClient from "effect/http/HttpClient";
import * as Response from "effect/http/HttpClientResponse";
import * as Redacted from "effect/Redacted";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Credentials } from "@distilled.cloud/cloudflare/Credentials";

// Two Containers built from one context share an image hash. Production on 22 Nov 2026: their
// shared publication pushed the image to one application's repository only, both applications ran
// that repository's reference, and the next update without a rebuild sent the other application
// its own repository @ the digest, a pair the registry never held, and Cloudflare refused the
// rollout that carried it (1601, IMAGE_REGISTRY_DOESNT_CONTAIN_IMAGE). These pin (a) an
// application whose recorded digest lives in another repository keeps that reference on an update
// with an unchanged input, through the update and through the attachment recreate, and (b) each
// application builds into, and runs, its own repository.
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

const DIGEST = `sha256:${"d".repeat(64)}`;
// The registry: which repositories hold which tags, and the digest every build produces.
let pushed, live, patches, rollouts, builds, deletes;
const reset = () => {
  pushed = new Map();
  live = new Map();
  patches = [];
  rollouts = [];
  builds = [];
  deletes = 0;
};
const repositoryOf = (reference) =>
  /^registry\.cloudflare\.com\/fixture\/([^@:]+)/u.exec(reference)?.[1];
let next = 1;
const answer = (request, status, body) =>
  Effect.succeed(Response.fromWeb(request, globalThis.Response.json(body, { status })));
const ok = (request, result) =>
  answer(request, 200, { success: true, errors: [], messages: [], result });
const http = HttpClient.make((request, url) => {
  if (url.hostname === "registry.cloudflare.com") {
    // `/v2/fixture/<repository>/manifests/<tag>`: only a repository a build pushed holds it.
    const [, repository] = /^\/v2\/fixture\/([^/]+)\/manifests\//u.exec(url.pathname) ?? [];
    return Effect.succeed(
      Response.fromWeb(
        request,
        pushed.has(repository)
          ? new globalThis.Response(null, {
              status: 200,
              headers: { "docker-content-digest": DIGEST },
            })
          : new globalThis.Response(null, { status: 404 }),
      ),
    );
  }
  if (url.pathname.endsWith("/credentials"))
    return ok(request, {
      account_id: "fixture",
      registry_host: "registry.cloudflare.com",
      username: "v1",
      password: "synthetic-never-sent",
    });
  const [, id, rest] = /\/containers\/applications(?:\/([^/]+))?(\/.*)?$/u.exec(url.pathname) ?? [];
  const body =
    request.body?._tag === "Uint8Array"
      ? JSON.parse(Buffer.from(request.body.body).toString())
      : {};
  if (rest === "/rollouts") {
    const image = body.target_configuration?.image ?? "";
    rollouts.push(image);
    // As Cloudflare answered on scratch (22 Nov): a rollout naming a repository that does not hold
    // the digest is refused with 1601; the PATCH before it accepts any image and changes nothing.
    return pushed.has(repositoryOf(image))
      ? ok(request, { id: "fixture-rollout" })
      : answer(request, 400, {
          success: false,
          errors: [{ code: 1601, message: "IMAGE_REGISTRY_DOESNT_CONTAIN_IMAGE" }],
          messages: [],
          result: null,
        });
  }
  if (request.method === "GET" && !id) return ok(request, [...live.values()]);
  if (request.method === "GET")
    return live.has(id)
      ? ok(request, live.get(id))
      : answer(request, 404, {
          success: false,
          errors: [{ code: 1609, message: "Container application not found" }],
          messages: [],
          result: null,
        });
  if (request.method === "POST") {
    // Whether Cloudflare's create checks the image as its rollout does is unknown; the stand-in
    // assumes it does, so a create naming a repository without the digest fails here too.
    if (!pushed.has(repositoryOf(body.configuration?.image ?? "")))
      return answer(request, 400, {
        success: false,
        errors: [{ code: 1601, message: "IMAGE_REGISTRY_DOESNT_CONTAIN_IMAGE" }],
        messages: [],
        result: null,
      });
    const app = { ...body, id: `app-${next++}`, account_id: "fixture", version: 1 };
    live.set(app.id, app);
    return ok(request, app);
  }
  if (request.method === "DELETE") {
    deletes++;
    live.delete(id);
    return ok(request, null);
  }
  patches.push(body);
  // A PATCH accepts any configuration and changes no image (scratch trial, 22 Nov).
  const current = live.get(id);
  const app = {
    ...current,
    ...body,
    configuration: current.configuration,
    version: current.version,
  };
  live.set(id, app);
  return ok(request, app);
});
const docker = {
  image: {
    // A build tags and pushes each of its tags; the registry then holds that repository.
    build: (options) =>
      Effect.sync(() => {
        builds.push(options.tag.filter((tag) => !tag.endsWith(":buildcache")));
        for (const tag of options.tag) pushed.set(repositoryOf(tag), DIGEST);
      }),
  },
};

const providers = Layer.mergeAll(
  LiveContainerProvider(),
  Provider.succeed(Worker, {
    stables: ["id"],
    precreate: ({ id }) =>
      Effect.succeed({ id, namespaces: { Blue: "ns-blue", Green: "ns-green" } }),
    reconcile: ({ id, news }) =>
      Effect.succeed({ id, ...news, namespaces: { Blue: "ns-blue", Green: "ns-green" } }),
    delete: () => Effect.void,
  }),
);
const context = mkdtempSync(join(tmpdir(), "basalt-shared-publication-"));
writeFileSync(join(context, "Dockerfile"), "FROM scratch\n");
const colours = ({ rollout } = {}) =>
  Effect.gen(function* () {
    const declare = (colour) =>
      Container(colour, {
        name: `fixture-${colour.toLowerCase()}`,
        context,
        className: colour,
        instanceType: "basic",
        // As src/pool/fleet-deployment.ts declares the colours.
        instances: 0,
        maxInstances: 4,
        ...(rollout ? { rollout } : {}),
      });
    const blue = yield* declare("Blue");
    const green = yield* declare("Green");
    const worker = yield* Worker("PoolWorker", {
      BLUE: blue.applicationId,
      GREEN: green.applicationId,
    });
    yield* blue.bind("Worker", { durableObjects: { namespaceId: worker.namespaces.Blue } });
    yield* green.bind("Worker", { durableObjects: { namespaceId: worker.namespaces.Green } });
  });
const dotAlchemy = mkdtempSync(join(tmpdir(), "basalt-shared-publication-state-"));
const deploy = (program, store) =>
  program.pipe(
    Stack.make({
      name: "publication",
      providers,
      state: Layer.effect(
        State,
        Effect.sync(() => InMemoryService(store)),
      ),
    }),
    Effect.flatMap((compiled) =>
      Plan.make(compiled).pipe(Effect.flatMap(apply), Effect.provide(compiled.services)),
    ),
    Effect.provideService(Stage, "test"),
    provideFreshArtifactStore,
  );
const imageOf = (name) => [...live.values()].find((app) => app.name === name)?.configuration?.image;
// (b) A first deploy: each colour builds into its own repository and runs its own reference.
const ownRepositories = Effect.gen(function* () {
  reset();
  const first = yield* Effect.exit(deploy(colours(), {}));
  assert.ok(Exit.isSuccess(first), "first deploy converges");
  assert.deepEqual(
    [imageOf("fixture-blue"), imageOf("fixture-green")],
    [
      `registry.cloudflare.com/fixture/fixture-blue@${DIGEST}`,
      `registry.cloudflare.com/fixture/fixture-green@${DIGEST}`,
    ],
    "each colour runs its own repository",
  );
  assert.ok(pushed.has("fixture-blue") && pushed.has("fixture-green"), "both repositories pushed");
});
// Production's state after a shared publication: blue runs green's repository, blue's own
// repository never received the digest, and Cloudflare reports 4 instances for each colour.
const sharedPublication = (store, attachment) =>
  Effect.gen(function* () {
    reset();
    assert.ok(Exit.isSuccess(yield* Effect.exit(deploy(colours(), store))), "setup deploy");
    // Replacing an existing key's value while iterating a Map visits each entry once.
    for (const app of live.values())
      live.set(app.id, {
        ...app,
        instances: 4,
        ...(app.name === "fixture-blue"
          ? {
              configuration: {
                ...app.configuration,
                image: `registry.cloudflare.com/fixture/fixture-green@${DIGEST}`,
              },
              ...(attachment ? { durable_objects: { namespace_id: attachment } } : {}),
            }
          : {}),
      });
    pushed.delete("fixture-blue");
    pushed.set("fixture-green", DIGEST);
    patches = [];
    rollouts = [];
    deletes = 0;
  });
const greenReference = `registry.cloudflare.com/fixture/fixture-green@${DIGEST}`;
// (a) An update with an unchanged input keeps blue's reference: production's PATCH of the declared
// count, and no rollout.
const unchangedOnAnotherRepository = Effect.gen(function* () {
  const store = {};
  yield* sharedPublication(store);
  const again = yield* Effect.exit(deploy(colours({ rollout: { strategy: "immediate" } }), store));
  assert.ok(
    Exit.isSuccess(again),
    `the unchanged update converges (rollouts: ${rollouts.join(", ")})`,
  );
  assert.deepEqual(rollouts, [], "no rollout: the configuration each colour runs is unchanged");
  assert.deepEqual(
    patches.map((body) => [body.instances, body.configuration?.image]).sort(),
    [
      [0, greenReference],
      [0, greenReference],
    ],
    "one PATCH per colour, for the declared count, naming the reference each runs",
  );
  assert.equal(imageOf("fixture-blue"), greenReference);
});
// (a) The attachment recreate keeps blue's reference too: it deletes blue, and the create names
// the repository that holds the digest.
const recreatedOnAnotherRepository = Effect.gen(function* () {
  const store = {};
  yield* sharedPublication(store, "ns-elsewhere");
  // The plan does not read the live attachment, so an update must reach reconcile, as it did in
  // production through an attachment that only resolves at apply.
  const again = yield* Effect.exit(deploy(colours({ rollout: { strategy: "immediate" } }), store));
  assert.ok(Exit.isSuccess(again), "the recreate converges");
  assert.equal(deletes, 1, "the moved attachment recreates blue once");
  assert.deepEqual(rollouts, []);
  const blue = [...live.values()].find((app) => app.name === "fixture-blue");
  assert.equal(blue?.durable_objects?.namespace_id, "ns-blue", "blue is attached again");
  assert.equal(blue?.configuration?.image, greenReference, "blue is created on its reference");
});
// Each scenario runs on its own, so a regression in one cannot hide the other.
const run = Effect.gen(function* () {
  const failed = [];
  for (const [name, scenario] of [
    ["own repositories", ownRepositories],
    ["unchanged input on another repository", unchangedOnAnotherRepository],
    ["attachment recreate on another repository", recreatedOnAnotherRepository],
  ]) {
    const exit = yield* Effect.exit(scenario);
    if (Exit.isFailure(exit)) failed.push(`${name}: ${String(Cause.squash(exit.cause))}`);
  }
  assert.deepEqual(failed, [], failed.join("\n"));
  console.log(JSON.stringify({ scenarios: 3 }));
}).pipe(
  Effect.provide(NodeServices.layer),
  Effect.provideService(AlchemyContext, { dotAlchemy, dev: false, adopt: false }),
  Effect.provideService(Docker, docker),
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
  rmSync(dotAlchemy, { recursive: true, force: true });
}
