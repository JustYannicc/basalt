import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";
import * as Response from "effect/http/HttpClientResponse";
import * as Redacted from "effect/Redacted";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Credentials } from "@distilled.cloud/cloudflare/Credentials";

// beta.80's wildcard exports name directories; its published runtime files are siblings.
const load = (name) => import(new URL(`../../../node_modules/alchemy/lib/${name}.js`, import.meta.url));
const { LiveContainerProvider } = await load("Cloudflare/Containers/ContainerProvider");
const { ContainerPlatform } = await load("Cloudflare/Containers/ContainerPlatform");
const { CloudflareEnvironment } = await load("Cloudflare/CloudflareEnvironment");
const { AlchemyContext } = await load("AlchemyContext");
const { Docker } = await load("Docker/Docker");
globalThis.fetch = () => { throw new Error("Real network access is forbidden in this provider regression"); };
const context = mkdtempSync(join(tmpdir(), "basalt-container-drift-"));
writeFileSync(join(context, "Dockerfile"), "FROM scratch\n");
const digest = (c) => `sha256:${c.repeat(64)}`;
const image = (d) => `registry.cloudflare.com/fixture/fixture-pool@${d}`;
let publishedDigest = digest("2");
let app = { id: "fixture-app", name: "fixture-pool", account_id: "fixture", version: 1,
  configuration: { image: image(publishedDigest) }, scheduling_policy: "default", max_instances: 1, instances: 1 };
let writes = 0;
let registryReads = 0;
const http = HttpClient.make((request, url) => {
  if (url.hostname === "registry.cloudflare.com") {
    registryReads++;
    return Effect.succeed(Response.fromWeb(request, new globalThis.Response(null, {
      status: 200, headers: { "docker-content-digest": publishedDigest },
    })));
  }
  let value = app;
  if (url.pathname.endsWith("/credentials")) {
    value = { account_id: "fixture", registry_host: "registry.cloudflare.com", username: "v1", password: "synthetic-never-sent" };
  } else if (url.pathname.endsWith("/rollouts")) {
    writes++;
    value = { id: "fixture-rollout" };
  } else if (request.method === "DELETE") {
    writes++;
  } else if (request.method === "GET" && url.pathname.endsWith("/applications")) {
    value = [app];
  } else if (request.method !== "GET") {
    writes++;
    assert.equal(request.body._tag, "Uint8Array");
    const body = JSON.parse(Buffer.from(request.body.body).toString());
    app = { ...app, ...body, version: app.version + 1 };
    value = app;
  }
  return Effect.succeed(Response.fromWeb(request, globalThis.Response.json({ success: true, errors: [], messages: [], result: value })));
});
const props = { name: "fixture-pool", context, className: "PoolContainer" };
const session = { note: () => Effect.void };
const program = Effect.gen(function* () {
  const provider = yield* ContainerPlatform.Provider;
  let expected = yield* provider.precreate({ id: "PoolContainer", news: props, session });
  const read = (output = expected) => provider.read({ id: "PoolContainer", olds: props, output });
  const diff = (output, news = props) => provider.diff({ id: "PoolContainer", olds: props, news, output, newBindings: [], oldBindings: [] });
  const reconcile = (output, news = props, bindings = []) => provider.reconcile({ id: "PoolContainer", news, bindings, output, session });
  assert.equal(expected.hash.digest, publishedDigest);
  assert.equal(yield* diff(yield* read()), undefined, "a matching observed digest stays unchanged");

  app.configuration.image = image(digest("4"));
  const drifted = yield* read();
  assert.equal(drifted.hash.image, expected.hash.image);
  assert.equal((yield* diff(drifted))?.action, "update", "a current input hash cannot hide drift");
  const beforeRecovery = registryReads;
  expected = yield* reconcile(drifted);
  assert.equal(expected.configuration.image, image(publishedDigest));
  assert.equal(app.configuration.image, image(publishedDigest));
  assert.equal(expected.hash.image, drifted.hash.image);
  assert.equal(registryReads, beforeRecovery, "a cached immutable digest needs no registry credentials");

  const afterRecovery = writes;
  assert.equal(yield* diff(yield* read()), undefined);
  expected = yield* reconcile(yield* read());
  assert.equal(writes, afterRecovery, "successful unchanged reconciliation does not update or roll out");

  app.configuration.image = image(digest("4"));
  const stale = yield* read();
  assert.equal((yield* diff(stale))?.action, "update", "an interrupted rollout remains recoverable after another stale read");
  expected = yield* reconcile(stale);
  assert.equal(expected.configuration.image, image(publishedDigest));

  const noDigest = { ...expected, hash: { ...expected.hash, digest: undefined } };
  const beforeMissing = registryReads;
  assert.equal((yield* diff(noDigest))?.action, "update");
  expected = yield* reconcile(noDigest);
  assert.ok(registryReads > beforeMissing, "missing provenance is resolved from the registry");
  assert.equal(expected.hash.digest, publishedDigest);

  writeFileSync(join(context, "runtime.txt"), "new runtime\n");
  publishedDigest = digest("3");
  assert.equal((yield* diff(yield* read()))?.action, "update");
  const oldHash = expected.hash.image;
  expected = yield* reconcile(yield* read());
  assert.notEqual(expected.hash.image, oldHash);
  assert.equal(expected.configuration.image, image(publishedDigest), "changed inputs select their newly published digest");

  app.configuration.image = image(digest("4"));
  const bindings = [{ data: { durableObjects: { namespaceId: "fixture-namespace" } } }];
  expected = yield* reconcile(yield* read(), props, bindings);
  assert.equal(expected.configuration.image, image(publishedDigest), "attachment recovery also selects the publication digest");
  return { scenarios: 7, inputHash: expected.hash.image, digest: expected.hash.digest };
}).pipe(
  Effect.provide(LiveContainerProvider()),
  Effect.provide(NodeServices.layer),
  Effect.provideService(AlchemyContext, { dotAlchemy: context, dev: false, adopt: false }),
  Effect.provideService(Docker, { image: { build: () => Effect.die(new Error("Unexpected Docker build")) } }),
  Effect.provideService(HttpClient.HttpClient, http),
  Effect.provideService(CloudflareEnvironment, Effect.succeed({ accountId: "fixture" })),
  Effect.provideService(Credentials, Effect.succeed({ type: "apiToken", apiToken: Redacted.make("synthetic-never-sent"), apiBaseUrl: "https://fixture.invalid" })),
);
try {
  console.log(JSON.stringify(await Effect.runPromise(program)));
} finally {
  rmSync(context, { recursive: true, force: true });
}
