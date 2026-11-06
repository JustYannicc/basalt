import assert from "node:assert/strict";
import { containerDriftApi, digest, image } from "./container-drift-api.mjs";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";
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
const state = containerDriftApi();
let props = {
  name: "fixture-pool",
  context,
  className: "PoolContainer",
  instanceType: "basic",
  maxInstances: 1,
  constraints: { regions: ["EEUR", "WEUR"], jurisdiction: "eu" },
};
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
  assert.equal(expected.hash.digest, state.publishedDigest);
  assert.equal(yield* diff(yield* read()), undefined, "a matching observed digest stays unchanged");

  state.app.configuration.image = image(digest("4"));
  const drifted = yield* read();
  assert.equal(drifted.hash.image, expected.hash.image);
  assert.equal((yield* diff(drifted))?.action, "update", "a current input hash cannot hide drift");
  const beforeRecovery = state.registryReads;
  const beforeDriftRollouts = state.rollouts;
  expected = yield* reconcile(drifted);
  assert.equal(expected.configuration.image, image(state.publishedDigest));
  assert.equal(state.app.configuration.image, image(state.publishedDigest));
  assert.equal(expected.hash.image, drifted.hash.image);
  assert.equal(
    state.registryReads,
    beforeRecovery,
    "a cached immutable digest needs no registry credentials",
  );
  assert.equal(state.rollouts, beforeDriftRollouts + 1, "image drift is repaired by a rollout");

  // A Durable Object starts an instance independently of the deployment declaration.
  state.app.instances = 1;
  const afterRecovery = state.writes;
  assert.equal(yield* diff(yield* read()), undefined);
  expected = yield* reconcile(yield* read());
  assert.equal(
    state.writes,
    afterRecovery,
    "successful unchanged reconciliation does not update or roll out",
  );
  expected = yield* reconcile(yield* read());
  assert.equal(
    state.writes,
    afterRecovery,
    "another release with the same container configuration remains unchanged",
  );

  assert.equal(state.app.instances, 1, "an unchanged release preserves the live instance");
  const beforeResourceChange = state.rollouts;
  const resized = { ...props, instanceType: "standard-1" };
  expected = yield* reconcile(yield* read(), resized);
  props = resized;
  assert.equal(state.rollouts, beforeResourceChange + 1, "a real resource change rolls out");
  assert.equal(state.app.configuration.vcpu, 0.5);
  assert.equal(state.app.configuration.memory_mib, 4096);
  assert.equal(
    state.app.instances,
    1,
    "a resource update does not reset an undeclared instance count",
  );
  assert.equal(state.updates.at(-1).instances, undefined);
  assert.deepEqual(state.app.constraints, props.constraints, "EU placement remains unchanged");
  const afterResize = state.writes;
  expected = yield* reconcile(yield* read());
  assert.equal(
    state.writes,
    afterResize,
    "expanded resource readback remains unchanged after resizing",
  );

  const beforeSettingsChange = state.writes;
  const beforeSettingsRollout = state.rollouts;
  props = {
    ...props,
    instances: 1,
    maxInstances: 3,
    constraints: { tier: 1 },
    affinities: { colocation: "datacenter" },
  };
  expected = yield* reconcile(yield* read());
  assert.equal(
    state.writes,
    beforeSettingsChange + 1,
    "declared scaling and placement changes update the application",
  );
  assert.equal(
    state.rollouts,
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
    state.app[key] = drift;
    const before = state.writes;
    expected = yield* reconcile(yield* read());
    assert.equal(state.writes, before + 1, `${key} drift updates despite a matching desired hash`);
    assert.deepEqual(state.app[key], desired, `${key} returns to the declared value`);
    assert.equal(
      state.rollouts,
      beforeSettingsRollout,
      `${key} repair does not roll out unchanged resources`,
    );
  }
  for (const instances of [0, 2]) {
    const before = state.writes;
    props = { ...props, instances };
    expected = yield* reconcile(yield* read());
    assert.equal(state.writes, before + 1, "an explicit count change updates the application");
    assert.equal(state.updates.at(-1).instances, instances, "explicit counts reach the update API");
    assert.equal(state.app.instances, instances);
    assert.equal(state.rollouts, beforeSettingsRollout, "scaling alone does not roll out");
  }
  const beforeRemovingCount = state.writes;
  const { instances: _instances, ...withoutInstances } = props;
  props = withoutInstances;
  expected = yield* reconcile(yield* read());
  assert.equal(state.app.instances, 2, "removing the count declaration preserves live capacity");
  assert.equal(
    state.writes,
    beforeRemovingCount,
    "giving up count ownership needs no application update",
  );
  const afterSettingsRecovery = state.writes;
  expected = yield* reconcile(yield* read());
  assert.equal(
    state.writes,
    afterSettingsRecovery,
    "repaired application settings remain unchanged",
  );

  state.app.configuration.vcpu = 1;
  const beforeResourceDrift = state.rollouts;
  expected = yield* reconcile(yield* read());
  assert.equal(
    state.rollouts,
    beforeResourceDrift + 1,
    "observed resource drift cannot hide behind a matching input hash",
  );
  assert.equal(state.app.configuration.vcpu, 0.5);
  state.app.configuration.command = ["unexpected-command"];
  const beforeCommandDrift = state.rollouts;
  expected = yield* reconcile(yield* read());
  assert.equal(
    state.rollouts,
    beforeCommandDrift + 1,
    "non-resource configuration drift still rolls out",
  );
  assert.equal(state.app.configuration.command, undefined);

  state.app.configuration.image = image(digest("4"));
  const stale = yield* read();
  assert.equal(
    (yield* diff(stale))?.action,
    "update",
    "an interrupted rollout remains recoverable after another stale read",
  );
  expected = yield* reconcile(stale);
  assert.equal(expected.configuration.image, image(state.publishedDigest));

  const noDigest = { ...expected, hash: { ...expected.hash, digest: undefined } };
  const beforeMissing = state.registryReads;
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
    state.registryReads > beforeMissing,
    "a fresh provider resolves missing provenance from the registry",
  );
  assert.equal(expected.hash.digest, state.publishedDigest);

  writeFileSync(join(context, "runtime.txt"), "new runtime\n");
  state.publishedDigest = digest("3");
  assert.equal((yield* diff(yield* read()))?.action, "update");
  const oldHash = expected.hash.image;
  const beforeImageChange = state.rollouts;
  expected = yield* reconcile(yield* read());
  assert.notEqual(expected.hash.image, oldHash);
  assert.equal(state.rollouts, beforeImageChange + 1, "a real image change rolls out");
  assert.equal(
    expected.configuration.image,
    image(state.publishedDigest),
    "changed inputs select their newly published digest",
  );

  state.app.configuration.image = image(digest("4"));
  const bindings = [{ data: { durableObjects: { namespaceId: "fixture-namespace" } } }];
  expected = yield* reconcile(yield* read(), props, bindings);
  assert.equal(
    expected.configuration.image,
    image(state.publishedDigest),
    "attachment recovery also selects the publication digest",
  );
  state.applicationExists = false;
  const beforeMissingApplication = state.writes;
  assert.equal(yield* read(), undefined, "a missing application is observed as absent");
  assert.equal((yield* diff(expected))?.action, "update", "a deleted application needs recovery");
  expected = yield* reconcile(expected, props, bindings);
  assert.ok(state.writes > beforeMissingApplication, "a missing application is recreated");
  assert.equal(state.applicationExists, true);
  assert.equal(expected.configuration.image, image(state.publishedDigest));
  assert.equal(state.app.durable_objects.namespace_id, "fixture-namespace");
  assert.equal(expected.maxInstances, 3);
  return {
    scenarios: 20,
    rollouts: state.rollouts,
    inputHash: expected.hash.image,
    digest: expected.hash.digest,
  };
}).pipe(
  Effect.provide(LiveContainerProvider()),
  Effect.provide(NodeServices.layer),
  Effect.provideService(AlchemyContext, { dotAlchemy: context, dev: false, adopt: false }),
  Effect.provideService(Docker, {
    image: { build: () => Effect.die(new Error("Unexpected Docker build")) },
  }),
  Effect.provideService(HttpClient.HttpClient, state.http),
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
