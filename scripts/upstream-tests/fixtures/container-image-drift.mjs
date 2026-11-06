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
const tree = process.argv[2] ?? "lib";
assert.ok(tree === "src" || tree === "lib");
const load = (name) =>
  import(
    new URL(
      `../../../node_modules/alchemy/${tree}/${name}.${tree === "src" ? "ts" : "js"}`,
      import.meta.url,
    )
  );
const { LiveContainerProvider } = await load("Cloudflare/Containers/ContainerProvider");
const { ContainerPlatform } = await load("Cloudflare/Containers/ContainerPlatform");
const { CloudflareEnvironment } = await load("Cloudflare/CloudflareEnvironment");
const { AlchemyContext } = await load("AlchemyContext");
const { Docker } = await load("Docker/Docker");
globalThis.fetch = () => {
  throw new Error("Real network access is forbidden in this provider regression");
};
const context = mkdtempSync(join(tmpdir(), "basalt-container-drift-"));
writeFileSync(join(context, "Dockerfile"), "FROM scratch\n");
const digest = (c) => `sha256:${c.repeat(64)}`;
const image = (d) => `registry.cloudflare.com/fixture/fixture-pool@${d}`;
let publishedDigest = digest("2");
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
let applicationExists = true;
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
  } else if (request.method === "GET" && !applicationExists) {
    return Effect.succeed(
      Response.fromWeb(
        request,
        globalThis.Response.json(
          {
            success: false,
            errors: [{ code: 1609, message: "Container application not found" }],
          },
          { status: 404 },
        ),
      ),
    );
  } else if (request.method !== "GET") {
    writes++;
    applicationExists = true;
    assert.equal(request.body._tag, "Uint8Array");
    const body = JSON.parse(Buffer.from(request.body.body).toString());
    // These are Cloudflare's documented presets and actual response units.
    const sizes = {
      basic: { vcpu: 0.25, memory: "1GiB", memory_mib: 1024, disk: { size: "4GB", size_mb: 4000 } },
      "standard-1": {
        vcpu: 0.5,
        memory: "4GiB",
        memory_mib: 4096,
        disk: { size: "8GB", size_mb: 8000 },
      },
    };
    const resources = sizes[body.configuration?.instance_type];
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
let props = { name: "fixture-pool", context, className: "PoolContainer", instanceType: "basic" };
const session = { note: () => Effect.void };
const program = Effect.gen(function* () {
  const provider = yield* ContainerPlatform.Provider;
  let expected = yield* provider.precreate({ id: "PoolContainer", news: props, session });
  const read = (output = expected) => provider.read({ id: "PoolContainer", olds: props, output });
  const diff = (output, news = props) =>
    provider.diff({
      id: "PoolContainer",
      olds: props,
      news,
      output,
      newBindings: [],
      oldBindings: [],
    });
  const reconcile = (output, news = props, bindings = []) =>
    provider.reconcile({ id: "PoolContainer", news, bindings, output, session });
  assert.equal(expected.hash.digest, publishedDigest);
  assert.equal(yield* diff(yield* read()), undefined, "a matching observed digest stays unchanged");

  app.configuration.image = image(digest("4"));
  const drifted = yield* read();
  assert.equal(drifted.hash.image, expected.hash.image);
  assert.equal((yield* diff(drifted))?.action, "update", "a current input hash cannot hide drift");
  const beforeRecovery = registryReads;
  const beforeDriftRollouts = rollouts;
  expected = yield* reconcile(drifted);
  assert.equal(expected.configuration.image, image(publishedDigest));
  assert.equal(app.configuration.image, image(publishedDigest));
  assert.equal(expected.hash.image, drifted.hash.image);
  assert.equal(
    registryReads,
    beforeRecovery,
    "a cached immutable digest needs no registry credentials",
  );
  assert.equal(rollouts, beforeDriftRollouts + 1, "image drift is repaired by a rollout");

  const afterRecovery = writes;
  assert.equal(yield* diff(yield* read()), undefined);
  expected = yield* reconcile(yield* read());
  assert.equal(
    writes,
    afterRecovery,
    "successful unchanged reconciliation does not update or roll out",
  );
  expected = yield* reconcile(yield* read());
  assert.equal(
    writes,
    afterRecovery,
    "another release with the same container configuration remains unchanged",
  );

  const beforeResourceChange = rollouts;
  const resized = { ...props, instanceType: "standard-1" };
  expected = yield* reconcile(yield* read(), resized);
  props = resized;
  assert.equal(rollouts, beforeResourceChange + 1, "a real resource change rolls out");
  assert.equal(app.configuration.vcpu, 0.5);
  assert.equal(app.configuration.memory_mib, 4096);
  const afterResize = writes;
  expected = yield* reconcile(yield* read());
  assert.equal(writes, afterResize, "expanded resource readback remains unchanged after resizing");

  const beforeSettingsChange = writes;
  const beforeSettingsRollout = rollouts;
  props = {
    ...props,
    instances: 1,
    maxInstances: 3,
    constraints: { tier: 1 },
    affinities: { colocation: "datacenter" },
  };
  expected = yield* reconcile(yield* read());
  assert.equal(
    writes,
    beforeSettingsChange + 1,
    "declared scaling and placement changes update the application",
  );
  assert.equal(
    rollouts,
    beforeSettingsRollout,
    "application settings do not roll out unchanged container resources",
  );
  for (const [key, drift, desired] of [
    ["max_instances", 30, 3],
    ["instances", 4, 1],
    ["scheduling_policy", "unexpected", "default"],
    ["constraints", { tier: 2 }, { tier: 1 }],
    ["affinities", {}, { colocation: "datacenter" }],
  ]) {
    app[key] = drift;
    const before = writes;
    expected = yield* reconcile(yield* read());
    assert.equal(writes, before + 1, `${key} drift updates despite a matching desired hash`);
    assert.deepEqual(app[key], desired, `${key} returns to the declared value`);
    assert.equal(
      rollouts,
      beforeSettingsRollout,
      `${key} repair does not roll out unchanged resources`,
    );
  }
  const afterSettingsRecovery = writes;
  expected = yield* reconcile(yield* read());
  assert.equal(writes, afterSettingsRecovery, "repaired application settings remain unchanged");

  app.configuration.vcpu = 1;
  const beforeResourceDrift = rollouts;
  expected = yield* reconcile(yield* read());
  assert.equal(
    rollouts,
    beforeResourceDrift + 1,
    "observed resource drift cannot hide behind a matching input hash",
  );
  assert.equal(app.configuration.vcpu, 0.5);
  app.configuration.command = ["unexpected-command"];
  const beforeCommandDrift = rollouts;
  expected = yield* reconcile(yield* read());
  assert.equal(
    rollouts,
    beforeCommandDrift + 1,
    "non-resource configuration drift still rolls out",
  );
  assert.equal(app.configuration.command, undefined);

  app.configuration.image = image(digest("4"));
  const stale = yield* read();
  assert.equal(
    (yield* diff(stale))?.action,
    "update",
    "an interrupted rollout remains recoverable after another stale read",
  );
  expected = yield* reconcile(stale);
  assert.equal(expected.configuration.image, image(publishedDigest));

  const noDigest = { ...expected, hash: { ...expected.hash, digest: undefined } };
  const beforeMissing = registryReads;
  assert.equal((yield* diff(noDigest))?.action, "update");
  expected = yield* Effect.gen(function* () {
    const freshProvider = yield* ContainerPlatform.Provider;
    return yield* freshProvider.reconcile({
      id: "PoolContainer",
      news: props,
      bindings: [],
      output: noDigest,
      session,
    });
  }).pipe(Effect.provide(LiveContainerProvider()));
  assert.ok(
    registryReads > beforeMissing,
    "a fresh provider resolves missing provenance from the registry",
  );
  assert.equal(expected.hash.digest, publishedDigest);

  writeFileSync(join(context, "runtime.txt"), "new runtime\n");
  publishedDigest = digest("3");
  assert.equal((yield* diff(yield* read()))?.action, "update");
  const oldHash = expected.hash.image;
  const beforeImageChange = rollouts;
  expected = yield* reconcile(yield* read());
  assert.notEqual(expected.hash.image, oldHash);
  assert.equal(rollouts, beforeImageChange + 1, "a real image change rolls out");
  assert.equal(
    expected.configuration.image,
    image(publishedDigest),
    "changed inputs select their newly published digest",
  );

  app.configuration.image = image(digest("4"));
  const bindings = [{ data: { durableObjects: { namespaceId: "fixture-namespace" } } }];
  expected = yield* reconcile(yield* read(), props, bindings);
  assert.equal(
    expected.configuration.image,
    image(publishedDigest),
    "attachment recovery also selects the publication digest",
  );
  applicationExists = false;
  const beforeMissingApplication = writes;
  assert.equal(yield* read(), undefined, "a missing application is observed as absent");
  assert.equal((yield* diff(expected))?.action, "update", "a deleted application needs recovery");
  expected = yield* reconcile(expected, props, bindings);
  assert.ok(writes > beforeMissingApplication, "a missing application is recreated");
  assert.equal(applicationExists, true);
  assert.equal(expected.configuration.image, image(publishedDigest));
  assert.equal(app.durable_objects.namespace_id, "fixture-namespace");
  assert.equal(expected.maxInstances, 3);
  return { scenarios: 20, rollouts, inputHash: expected.hash.image, digest: expected.hash.digest };
}).pipe(
  Effect.provide(LiveContainerProvider()),
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
);
try {
  console.log(JSON.stringify(await Effect.runPromise(program)));
} finally {
  rmSync(context, { recursive: true, force: true });
}
