import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { capturePoolImage } from "../../deploy-safety/capture-pool-image.ts";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as Layer from "effect/Layer";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";
import * as Response from "effect/http/HttpClientResponse";
import * as Redacted from "effect/Redacted";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Credentials } from "@distilled.cloud/cloudflare/Credentials";

// Deployments run the package's Bun source entry points.
const load = (name) =>
  import(
    new URL(
      `${process.env.ALCHEMY_PUBLICATION_FIXTURE ?? "../../../node_modules/alchemy/"}src/${name}.ts`,
      import.meta.url,
    )
  );
const { LiveContainerProvider } = await load("Cloudflare/Containers/ContainerProvider");
const { ContainerPlatform } = await load("Cloudflare/Containers/ContainerPlatform");
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
const Receipt = Resource("Fixture.Receipt");
globalThis.fetch = () => {
  throw new Error("Real network access is forbidden in this provider regression");
};
const context = mkdtempSync(join(tmpdir(), "basalt-container-drift-"));
writeFileSync(join(context, "Dockerfile"), "FROM scratch\n");
const hash = (bytes) => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
const image = (digest) => `registry.cloudflare.com/fixture/fixture-pool@${digest}`;
const registry = new Map();
function publication(revision) {
  const config = JSON.stringify({
    os: "linux",
    architecture: "amd64",
    config: {
      Labels: { "io.signalbox.pool.oauth-completion-receipts": "1", "fixture.revision": revision },
    },
  });
  const configDigest = hash(config);
  const manifest = JSON.stringify({
    schemaVersion: 2,
    config: { digest: configDigest },
    layers: [],
  });
  const digest = hash(manifest);
  registry.set(configDigest, config);
  registry.set(digest, manifest);
  return digest;
}
let publishedDigest = publication("first");
let app = {
  id: "fixture-app",
  name: "fixture-pool",
  account_id: "fixture",
  version: 1,
  configuration: { image: image(publishedDigest) },
  scheduling_policy: "default",
  max_instances: 1,
  instances: 1,
};
let writes = 0;
let rollouts = 0;
let registryReads = 0;
let applicationExists = false;
const http = HttpClient.make((request, url) => {
  if (url.hostname === "registry.cloudflare.com") {
    registryReads++;
    return Effect.succeed(
      Response.fromWeb(
        request,
        new globalThis.Response(null, {
          status: 200,
          headers: { "docker-content-digest": publishedDigest },
        }),
      ),
    );
  }
  let value = app;
  if (url.pathname.endsWith("/credentials")) {
    value = {
      account_id: "fixture",
      registry_host: "registry.cloudflare.com",
      username: "v1",
      password: "synthetic-never-sent",
    };
  } else if (url.pathname.endsWith("/rollouts")) {
    writes++;
    rollouts++;
    value = { id: "fixture-rollout" };
  } else if (request.method === "DELETE") {
    writes++;
    applicationExists = false;
  } else if (request.method === "GET" && url.pathname.endsWith("/applications")) {
    value = applicationExists ? [app] : [];
  } else if (request.method !== "GET") {
    writes++;
    applicationExists = true;
    assert.equal(request.body._tag, "Uint8Array");
    const body = JSON.parse(Buffer.from(request.body.body).toString());
    const resources = {
      basic: { vcpu: 0.25, memory: "1GiB", memory_mib: 1024, disk: { size: "4GB", size_mb: 4000 } },
      "standard-1": {
        vcpu: 0.5,
        memory: "4GiB",
        memory_mib: 4096,
        disk: { size: "8GB", size_mb: 8000 },
      },
    }[body.configuration?.instance_type];
    if (resources) {
      delete body.configuration.instance_type;
      Object.assign(body.configuration, resources);
    }
    app = { ...app, ...body, version: app.version + 1 };
    value = app;
  }
  return Effect.succeed(
    Response.fromWeb(
      request,
      globalThis.Response.json({ success: true, errors: [], messages: [], result: value }),
    ),
  );
});

const receiptDirectory = mkdtempSync(join(tmpdir(), "basalt-publication-receipt-"));
const receiptPath = join(receiptDirectory, "receipt.json");
const metadataFetch = async (url) => {
  const parsed = new URL(url);
  if (parsed.hostname === "api.cloudflare.com" && parsed.pathname.endsWith("/credentials")) {
    return globalThis.Response.json({
      success: true,
      errors: [],
      messages: [],
      result: { username: "fixture", password: "synthetic-never-sent" },
    });
  }
  if (parsed.hostname === "registry.cloudflare.com") {
    const bytes = registry.get(parsed.pathname.split("/").at(-1));
    if (bytes) return new globalThis.Response(bytes, { status: 200 });
  }
  throw new Error(`Unexpected metadata request: ${parsed.pathname}`);
};
const props = { name: "fixture-pool", context, className: "PoolContainer", instanceType: "basic" };
const store = {};
const state = Layer.effect(
  State,
  Effect.sync(() => InMemoryService(store)),
);
const providers = Layer.mergeAll(
  LiveContainerProvider(),
  Provider.succeed(Worker, {
    stables: ["id"],
    precreate: ({ id }) => Effect.succeed({ id }),
    reconcile: ({ id, news }) => Effect.succeed({ id, ...news }),
    delete: () => Effect.void,
  }),
  Provider.succeed(Receipt, {
    reconcile: ({ id, news }) =>
      Effect.promise(async () => {
        rmSync(receiptPath, { force: true });
        await capturePoolImage(
          {
            BASALT_POOL_IMAGE_RECEIPT: receiptPath,
            GITHUB_SHA: "a".repeat(40),
            CLOUDFLARE_ACCOUNT_ID: "fixture",
            CLOUDFLARE_API_TOKEN: "synthetic-never-sent",
            POOL_APPLICATION_ID: "fixture-app",
            POOL_IMAGE_INPUT_HASH: news.inputHash,
            POOL_IMAGE_DIGEST: news.digest,
            POOL_IMAGE_REF: news.imageRef,
            POOL_WORKER_READY: news.worker,
          },
          metadataFetch,
        );
        return { id, ...JSON.parse(readFileSync(receiptPath, "utf8")) };
      }),
    delete: () => Effect.void,
  }),
);
const program = Effect.gen(function* () {
  const application = yield* Container("PoolContainer", props);
  const worker = yield* Worker("PoolWorker", { POOL_IMAGE_HASH: application.hash.image });
  yield* application.bind("Worker", { durableObjects: { namespaceId: worker.id } });
  yield* Receipt("PublicationReceipt", {
    inputHash: application.hash.image,
    digest: application.hash.digest,
    imageRef: application.configuration.image,
    worker: worker.id,
  });
});
let lastActions;
const deploy = () =>
  program.pipe(
    Stack.make({ name: "publication", providers, state }),
    Effect.flatMap((compiled) =>
      Plan.make(compiled).pipe(
        Effect.tap((plan) =>
          Effect.sync(() => {
            lastActions = Object.fromEntries(
              Object.entries(plan.resources).map(([id, node]) => [id, node.action]),
            );
          }),
        ),
        Effect.flatMap(apply),
        Effect.provide(compiled.services),
      ),
    ),
    Effect.provideService(Stage, "test"),
    provideFreshArtifactStore,
  );
function assertPublication() {
  const rows = store.publication.test;
  const receipt = JSON.parse(readFileSync(receiptPath, "utf8"));
  assert.equal(rows.PoolContainer.attr.hash.digest, publishedDigest);
  assert.equal(app.configuration.image, image(publishedDigest), "the published digest is deployed");
  assert.equal(
    receipt.digest,
    publishedDigest,
    "the actual capture script receives the new publication digest",
  );
  assert.equal(receipt.inputHash, rows.PoolContainer.attr.hash.image);
  assert.equal(
    rows.PoolWorker.attr.POOL_IMAGE_HASH,
    receipt.inputHash,
    "the Worker receives the publication's new input hash",
  );
  return rows;
}
const run = Effect.gen(function* () {
  yield* deploy();
  const initial = assertPublication().PoolContainer.attr.hash.image;
  writeFileSync(join(context, "runtime.txt"), "new runtime\n");
  publishedDigest = publication("second");
  const beforeImageChange = rollouts;
  yield* deploy();
  assert.notEqual(assertPublication().PoolContainer.attr.hash.image, initial);
  assert.equal(rollouts, beforeImageChange + 1, "changed context rolls out");

  const beforeNoop = writes;
  yield* deploy();
  assertPublication();
  assert.deepEqual(lastActions, {
    PoolContainer: "noop",
    PoolWorker: "noop",
    PublicationReceipt: "noop",
  });
  assert.equal(writes, beforeNoop, "unchanged redeploy makes no application or rollout writes");

  props.instanceType = "standard-1";
  const beforeResize = rollouts;
  yield* deploy();
  assertPublication();
  assert.equal(rollouts, beforeResize + 1, "real resource changes still roll out");
  assert.equal(app.configuration.vcpu, 0.5);

  const beforeResizedNoop = writes;
  yield* deploy();
  assertPublication();
  assert.equal(writes, beforeResizedNoop, "unchanged resized context stays a no-op");

  app.configuration.image = image(publication("foreign"));
  const beforeRepair = rollouts;
  yield* deploy();
  assertPublication();
  assert.equal(rollouts, beforeRepair + 1, "image drift is repaired");
  console.log(
    JSON.stringify({ scenarios: 5, rollouts, actions: lastActions, digest: publishedDigest }),
  );
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
  rmSync(receiptDirectory, { recursive: true, force: true });
}
