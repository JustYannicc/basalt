import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { Effect, Cause, FileSystem, Path, Redacted, ConfigProvider } from "effect";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpResponse from "effect/http/HttpClientResponse";
import * as HttpError from "effect/http/HttpClientError";
import { Credentials } from "@distilled.cloud/cloudflare/Credentials";
import * as Retry from "@distilled.cloud/cloudflare/Retry";
import { applyRuntimeCreate } from "../provisioning-apply.ts";
import { runtimeNativeState } from "../provisioning-native.ts";
import { applicationTemplateDigest, expectedApplicationRequest } from "../provisioning-wire.ts";
import { provisioningJournal } from "../provisioning-journal.ts";
import { provisioningManifestDigest } from "../provisioning-contract.ts";
import { assertSupportedPlan } from "../plan-admission.ts";
const tree = process.argv[2];
const load = (name) =>
  import(
    new URL(
      `../../../node_modules/alchemy/${tree}/${name}.${tree === "src" ? "ts" : "js"}`,
      import.meta.url,
    )
  );
const [
  { LiveContainerProvider },
  { ContainerPlatform },
  { AlchemyContext },
  { CloudflareEnvironment },
  { Docker },
  { StackContext },
  { Stage },
  { InstanceId },
  { InMemoryService },
  { State },
  Apply,
] = await Promise.all([
  load("Cloudflare/Containers/ContainerProvider"),
  load("Cloudflare/Containers/ContainerPlatform"),
  load("AlchemyContext"),
  load("Cloudflare/CloudflareEnvironmentService"),
  load("Docker/Docker"),
  load("StackContext"),
  load("Stage"),
  load("InstanceId"),
  load("State/InMemoryState"),
  load("State/State"),
  load("Apply"),
]);
globalThis.fetch = () => {
  throw new Error("REAL NETWORK DENIED");
};
const account = "1".repeat(32),
  namespace = "2".repeat(32),
  instance = "3".repeat(32);
const image = `registry.cloudflare.com/${account}/synthetic-runtime@sha256:${"a".repeat(64)}`;
const root = mkdtempSync(join(tmpdir(), "runtime-provisioning-proof-"));
process.on("exit", () => rmSync(root, { recursive: true, force: true }));
const credentials = Effect.succeed({
  type: "apiToken",
  apiToken: Redacted.make("synthetic-never-sent"),
  apiBaseUrl: "https://api.cloudflare.com/client/v4",
});
const props = {
  name: "synthetic-runtime",
  className: "PoolRuntime",
  image,
  instances: 0,
  maxInstances: 1,
  instanceType: "basic",
  schedulingPolicy: "default",
  constraints: { jurisdiction: "eu", regions: ["EEUR", "WEUR"] },
  observability: { logs: { enabled: true } },
};
const binding = {
  action: "create",
  sid: "PoolWorker:PoolRuntime",
  source: "PoolWorker",
  target: "PoolRuntime",
  data: { durableObjects: { namespaceId: namespace } },
};
const manifest = {
  schemaVersion: 3,
  disposition: "provision-only",
  candidate: "c".repeat(40),
  stack: "synthetic",
  stage: "production",
  operationId: "synthetic-operation",
  declaration: {
    action: "create-container",
    type: "Cloudflare.Container",
    fqn: "PoolRuntime",
    disposition: "provision-only",
    baseline: "absent",
    accountId: account,
    instanceId: instance,
    namespace: { workerFqn: "PoolWorker", className: "PoolRuntime", binding: "PoolRuntime" },
    props,
    publication: {
      inputHash: "d".repeat(16),
      imageConfigDigest: `sha256:${"e".repeat(64)}`,
      platform: "linux/amd64",
      capabilityLabel: "1",
    },
    sdkSourceDigest: createHash("sha256")
      .update(
        readFileSync(
          new URL(
            "../../../node_modules/alchemy/src/Cloudflare/Containers/ContainerProvider.ts",
            import.meta.url,
          ),
        ),
      )
      .digest("hex"),
    removalPolicy: "retain",
    retention: { data: true, nativeStateRow: true, recoveryDescriptor: true },
  },
  namespaceBaselineDigest: "f".repeat(64),
  namespaceRequestDigest: "a".repeat(64),
  applicationTemplateDigest: "b".repeat(64),
  active: {
    applicationId: "legacy-app",
    namespaceId: "legacy-namespace",
    version: 31,
    configurationDigest: "0".repeat(64),
    bootId: "legacy-boot",
    selectionEpoch: 0,
  },
};
manifest.applicationTemplateDigest = applicationTemplateDigest(
  expectedApplicationRequest(manifest, namespace),
  namespace,
);
const enable = {
  coordinatorGo: "synthetic-ONLY",
  manifest: provisioningManifestDigest(manifest),
  writerLease: "synthetic-exclusive-owner",
  expiresAt: 1000,
};
function memoryStore() {
  let saved;
  return {
    exclusive: (work) => work(),
    read: async () => saved,
    write: async (record) => {
      saved = structuredClone(record);
    },
  };
}
function makeWire(options = {}) {
  const calls = [],
    apps = [];
  const collection = `/client/v4/accounts/${account}/containers/applications`;
  if (options.collision)
    apps.push({
      id: "foreign-app",
      name: props.name,
      account_id: account,
      created_at: "2026-11-09T00:00:00Z",
      version: 1,
      ...expectedApplicationRequest(manifest, "foreign-namespace"),
    });
  const client = HttpClient.make((request, url) =>
    Effect.gen(function* () {
      assert.equal(url.origin, "https://api.cloudflare.com");
      const body =
        request.body._tag === "Uint8Array"
          ? JSON.parse(new TextDecoder().decode(request.body.body))
          : undefined;
      const call = { method: request.method, path: url.pathname, body };
      calls.push(call);
      let result;
      if (request.method === "GET" && url.pathname === collection) result = apps;
      else if (request.method === "GET" && url.pathname === `${collection}/synthetic-created-app`)
        result = apps[0];
      else if (request.method === "POST" && url.pathname === collection) {
        if (options.captureOnly) {
          call.disposition = "captured-no-dispatch";
          return yield* Effect.die("CAPTURED_WITHOUT_DISPATCH");
        }
        result = {
          id: "synthetic-created-app",
          account_id: account,
          created_at: "2026-11-09T00:00:00Z",
          version: 1,
          ...body,
        };
        apps.push(result);
        call.disposition = "sent-to-fake";
        if (options.loseReply)
          return yield* Effect.fail(
            new HttpError.HttpClientError({ reason: new HttpError.TransportError({ request }) }),
          );
      } else return yield* Effect.die(`UNAPPROVED WIRE CALL ${request.method} ${url.pathname}`);
      return HttpResponse.fromWeb(
        request,
        Response.json({ success: true, errors: [], messages: [], result }),
      );
    }),
  );
  return { client, calls, apps };
}
const services = (effect, wire) =>
  effect.pipe(
    Retry.none,
    Effect.provideService(HttpClient.HttpClient, wire.client),
    Effect.provideService(Credentials, credentials),
    Effect.provideService(CloudflareEnvironment, Effect.succeed({ accountId: account })),
    Effect.provideService(AlchemyContext, { dotAlchemy: root, dev: false, adopt: false }),
    Effect.provideService(FileSystem.FileSystem, FileSystem.makeNoop({})),
    Effect.provide(Path.layer),
    Effect.provideService(Docker, new Proxy({}, { get: () => () => Effect.die("DOCKER DENIED") })),
    Effect.provideService(StackContext, { name: "synthetic", stage: "production" }),
    Effect.provideService(Stage, "production"),
    Effect.provideService(InstanceId, instance),
    Effect.provide(ConfigProvider.layer(ConfigProvider.fromEnv({ env: {} }))),
  );
async function run(wire, options = {}) {
  const legacy = {
    status: "created",
    fqn: "PoolContainer",
    logicalId: "PoolContainer",
    resourceType: "Cloudflare.Container",
    instanceId: "legacy-native-id",
    props: { image: "legacy-image", config: "legacy-config" },
    attr: { applicationId: "legacy-app", version: 31, boot: "legacy-boot" },
    bindings: [],
    downstream: [],
    providerVersion: 0,
  };
  const stateRows = {
    synthetic: {
      production: {
        PoolContainer: structuredClone(legacy),
        ...(options.prior ? { PoolRuntime: options.prior } : {}),
      },
    },
  };
  const store = options.store ?? memoryStore();
  const program = Effect.gen(function* () {
    const provider = yield* ContainerPlatform.Provider;
    const memory = yield* InMemoryService(stateRows);
    const plan = {
      resources: {
        PoolRuntime: {
          resource: {
            Type: "Cloudflare.Container",
            LogicalId: "PoolRuntime",
            FQN: "PoolRuntime",
            Props: options.props ?? props,
            Namespace: undefined,
            RemovalPolicy: "retain",
          },
          provider,
          action: "create",
          props: options.props ?? props,
          state: undefined,
          downstream: [],
          bindings: options.missingNamespace ? [] : [binding],
        },
      },
      actions: {},
      deletions: {},
      actionDeletions: {},
      output: undefined,
      cycleMembers: new Set(),
    };
    if (options.currentAdmission) assertSupportedPlan(plan);
    if (options.defaultProvider)
      yield* Apply.apply(plan).pipe(Effect.provideService(State, Effect.succeed(memory)));
    else {
      const context = yield* Effect.context();
      const perform = () =>
        Effect.runPromise(
          applyRuntimeCreate(
            plan,
            options.manifest ?? manifest,
            options.namespace ?? namespace,
            options.enable ?? enable,
            () => 100,
          ).pipe(
            Effect.provideContext(context),
            Effect.provideService(State, Effect.succeed(memory)),
          ),
        );
      yield* Effect.promise(() =>
        provisioningJournal(store, manifest.candidate, enable.manifest).once(
          "application-create",
          "b".repeat(64),
          perform,
          (value) => value,
        ),
      );
      const native = yield* runtimeNativeState(manifest, namespace).pipe(
        Effect.provideService(State, Effect.succeed(memory)),
      );
      assert.match(native.digest, /^[a-f0-9]{64}$/u);
      assert.equal(native.application.applicationName, props.name);
      assert.equal(native.application.durableObjects.namespaceId, namespace);
      assert.equal(native.application.configuration.image, image);
      assert.equal(native.application.instances, 0);
    }
    return stateRows;
  }).pipe(Effect.provide(LiveContainerProvider()));
  const exit = await Effect.runPromise(services(Effect.exit(program), wire));
  assert.deepEqual(
    stateRows.synthetic.production.PoolContainer,
    legacy,
    "active legacy native row changed",
  );
  return exit;
}
const count = (wire) =>
  wire.calls.filter((call) => call.method === "POST" && call.disposition === "sent-to-fake").length;
const rejected = async (options, wireOptions = {}) => {
  const wire = makeWire(wireOptions);
  assert.equal((await run(wire, options))._tag, "Failure");
  assert.equal(count(wire), 0);
};
const normal = makeWire();
const defaultResult = await run(normal, { defaultProvider: true });
assert.equal(defaultResult._tag, "Failure");
assert.equal(count(normal), 1, "default precreate must expose the first unattached create");
assert.equal(
  normal.calls.some((call) => call.method === "DELETE"),
  true,
  defaultResult._tag === "Failure" ? Cause.pretty(defaultResult.cause) : "default hazard absent",
);
const final = makeWire();
const success = await run(final);
assert.equal(
  success._tag,
  "Success",
  success._tag === "Failure" ? Cause.pretty(success.cause) : "",
);
assert.equal(count(final), 1);
assert.equal(
  final.calls.some((call) => call.method === "DELETE"),
  false,
);
assert.equal(final.apps[0].durable_objects.namespace_id, namespace);
const store = memoryStore(),
  lost = makeWire({ loseReply: true });
assert.equal((await run(lost, { store }))._tag, "Failure");
assert.equal(count(lost), 1);
const replay = makeWire();
assert.equal((await run(replay, { store }))._tag, "Failure");
assert.equal(count(replay), 0);
const crashed = memoryStore(),
  write = crashed.write;
crashed.write = async (value) => {
  await write(value);
  throw new Error("CRASH_AFTER_INTENT");
};
await rejected({ store: crashed });
crashed.write = write;
await rejected({ store: crashed });
await rejected({ namespace: "wrong-namespace" });
await rejected({ props: { ...props, image: "wrong-image" } });
await rejected({}, { collision: true });
await rejected({ missingNamespace: true });
await rejected({ currentAdmission: true });
await rejected({}, { captureOnly: true });
console.log("__PROVISIONING_PROOF_PASS__");
