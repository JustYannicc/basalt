import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { Effect, FileSystem, Path, Redacted, ConfigProvider, Layer } from "effect";
import * as Cloudflare from "alchemy/Cloudflare";
import { Stack, evalStack } from "alchemy/Stack";
import { fleetInfrastructure } from "../../../src/pool/fleet-deployment.ts";
import { withReleaseRuntime } from "../runtime.ts";
import { provisionDeclaredRuntime } from "../provisioning-declarations.ts";
import { applicationTemplateDigest, expectedApplicationRequest } from "../provisioning-wire.ts";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpResponse from "effect/http/HttpClientResponse";
import { Credentials } from "@distilled.cloud/cloudflare/Credentials";
import * as Retry from "@distilled.cloud/cloudflare/Retry";
import { runtimeProvisioningProvider } from "../provisioning-cloudflare.ts";
import { provisionRuntime } from "../runtime-provisioning.ts";
import { provisioningManifestDigest } from "../provisioning-contract.ts";
import { provisioningFixture } from "./provisioning-fixtures.ts";
const tree = process.argv[2];
const resource = process.argv[3] ?? "PoolRuntime";
const sourceDrift = process.argv[4] === "source-drift";
const sourcePlan = process.argv[4] === "source" || sourceDrift;
assert.ok(["PoolRuntime", "PoolRuntimeBlue", "PoolRuntimeGreen"].includes(resource));
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
]);
globalThis.fetch = () => {
  throw new Error("REAL NETWORK DENIED");
};
const f = provisioningFixture(resource);
f.manifest.declaration.sdkSourceDigest = createHash("sha256")
  .update(
    readFileSync(
      new URL(
        "../../../node_modules/alchemy/src/Cloudflare/Containers/ContainerProvider.ts",
        import.meta.url,
      ),
    ),
  )
  .digest("hex");
if (sourcePlan) {
  assert.ok(resource === "PoolRuntimeBlue" || resource === "PoolRuntimeGreen");
  f.manifest.declaration.props = {
    ...f.manifest.declaration.props,
    isExternal: true,
    name: `basalt-production-pool-runtime-${resource === "PoolRuntimeBlue" ? "blue" : "green"}`,
  };
  f.manifest.applicationTemplateDigest = applicationTemplateDigest(
    expectedApplicationRequest(f.manifest, f.namespaceId),
    f.namespaceId,
  );
}
if (sourceDrift)
  f.manifest.declaration.props = { ...f.manifest.declaration.props, name: "foreign-declaration" };
f.enable.manifest = provisioningManifestDigest(f.manifest);
const account = f.manifest.declaration.accountId,
  script = f.baseline.scriptName;
const root = mkdtempSync(join(tmpdir(), "runtime-provisioning-full-flow-"));
process.on("exit", () => rmSync(root, { recursive: true, force: true }));
const base = `/client/v4/accounts/${account}`;
const baseline = {
  id: f.baseline.version.id,
  number: 1,
  urls: [],
  created_on: "2026-11-09T00:00:00Z",
  main_module: f.baseline.version.mainModule,
  modules: f.baseline.version.modules.map((part) => ({
    name: part.name,
    content_type: part.contentType,
    content_base64: part.contentBase64,
  })),
  containers: [{ class_name: "PoolContainer" }],
  exports: {
    default: { type: "worker", cache_options: { enabled: true } },
    PoolContainer: {
      type: "durable-object",
      storage: "sqlite",
      container: "PoolContainer",
      state: "created",
    },
  },
  bindings: [
    {
      name: "PoolContainer",
      type: "durable_object_namespace",
      namespace_id: "legacy-namespace",
      class_name: "PoolContainer",
    },
    { name: "KEEP", type: "plain_text", text: "synthetic-private-setting" },
  ],
  cache_options: { enabled: true },
  compatibility_date: "2026-06-01",
  compatibility_flags: ["nodejs_compat"],
  usage_model: "standard",
  limits: { cpu_ms: 30_000 },
  placement: { mode: "smart" },
};
let staged,
  deployed = baseline.id,
  application,
  saved;
const calls = [];
const client = HttpClient.make((request, url) =>
  Effect.sync(() => {
    assert.equal(url.origin, "https://api.cloudflare.com");
    const body =
      request.body._tag === "Uint8Array"
        ? JSON.parse(new TextDecoder().decode(request.body.body))
        : undefined;
    calls.push({ method: request.method, path: url.pathname });
    let result;
    if (
      request.method === "GET" &&
      url.pathname === `${base}/workers/scripts/${script}/deployments`
    )
      result = {
        deployments: [
          {
            id: deployed === baseline.id ? "prior-deployment" : "new-deployment",
            created_on: "2026-11-09T00:00:00Z",
            source: "api",
            strategy: "percentage",
            versions: [{ version_id: deployed, percentage: 100 }],
          },
        ],
      };
    else if (
      request.method === "GET" &&
      url.pathname === `${base}/workers/workers/${script}/versions/${baseline.id}`
    )
      result = baseline;
    else if (
      request.method === "GET" &&
      url.pathname === `${base}/workers/workers/${script}/versions/staged-version`
    )
      result = staged;
    else if (
      request.method === "GET" &&
      url.pathname === `${base}/workers/durable_objects/namespaces`
    )
      result = [
        { id: "legacy-namespace", script, class: "PoolContainer", use_sqlite: true },
        ...(deployed === "staged-version"
          ? [{ id: f.namespaceId, script, class: resource, use_sqlite: true }]
          : []),
      ];
    else if (
      request.method === "POST" &&
      url.pathname === `${base}/workers/workers/${script}/versions`
    ) {
      assert.equal(url.searchParams.get("deploy"), "false");
      assert.deepEqual(body.exports.PoolContainer, baseline.exports.PoolContainer);
      assert.deepEqual(body.exports.default, baseline.exports.default);
      assert.deepEqual(body.containers, [
        { class_name: "PoolContainer" },
        { class_name: resource },
      ]);
      staged = {
        ...body,
        id: "staged-version",
        number: 2,
        created_on: "2026-11-09T00:00:00Z",
        urls: [],
        bindings: [
          ...baseline.bindings,
          {
            name: resource,
            type: "durable_object_namespace",
            class_name: resource,
            namespace_id: f.namespaceId,
          },
        ],
      };
      result = staged;
    } else if (
      request.method === "POST" &&
      url.pathname === `${base}/workers/scripts/${script}/deployments`
    ) {
      assert.deepEqual(body.versions, [{ percentage: 100, version_id: "staged-version" }]);
      assert.ok(staged);
      deployed = "staged-version";
      result = {
        id: "new-deployment",
        created_on: "2026-11-09T00:00:00Z",
        source: "api",
        strategy: "percentage",
        versions: body.versions,
      };
    } else if (request.method === "GET" && url.pathname === `${base}/containers/applications`)
      result = application ? [application] : [];
    else if (request.method === "POST" && url.pathname === `${base}/containers/applications`) {
      assert.equal(deployed, "staged-version");
      assert.equal(body.durable_objects.namespace_id, f.namespaceId);
      assert.equal(application, undefined);
      application = {
        id: "new-application",
        account_id: account,
        created_at: "2026-11-09T00:00:00Z",
        version: 1,
        ...body,
      };
      result = application;
    } else if (
      request.method === "GET" &&
      url.pathname === `${base}/containers/applications/new-application`
    )
      result = application;
    else throw new Error(`UNAPPROVED WIRE CALL ${request.method} ${url.pathname}`);
    return HttpResponse.fromWeb(
      request,
      Response.json({
        success: true,
        errors: [],
        messages: [],
        result,
        ...(Array.isArray(result)
          ? {
              result_info: {
                page: 1,
                per_page: 100,
                count: result.length,
                total_count: result.length,
                total_pages: 1,
              },
            }
          : {}),
      }),
    );
  }),
);
const legacy = {
  status: "created",
  fqn: "PoolContainer",
  logicalId: "PoolContainer",
  resourceType: "Cloudflare.Container",
  instanceId: "legacy",
  props: { image: "legacy-image" },
  attr: { applicationId: "legacy-app", version: 31 },
  bindings: [],
  downstream: [],
  providerVersion: 0,
};
const stateRows = { synthetic: { production: { PoolContainer: structuredClone(legacy) } } };
const program = Effect.gen(function* () {
  const provider = yield* ContainerPlatform.Provider;
  const state = yield* InMemoryService(stateRows);
  const props = f.manifest.declaration.props;
  const plan = {
    resources: {
      [resource]: {
        resource: {
          Type: "Cloudflare.Container",
          LogicalId: resource,
          FQN: resource,
          Props: props,
          Namespace: undefined,
          RemovalPolicy: "retain",
        },
        provider,
        props,
        action: "create",
        state: undefined,
        downstream: [],
        bindings: [
          {
            action: "create",
            sid: `PoolWorker:${resource}`,
            source: "PoolWorker",
            target: resource,
            data: { durableObjects: { namespaceId: f.namespaceId } },
          },
        ],
      },
    },
    actions: {},
    deletions: {},
    actionDeletions: {},
    output: undefined,
    cycleMembers: new Set(),
  };
  const store = {
    exclusive: (work) => work(),
    read: async () => saved,
    write: async (value) => {
      saved = structuredClone(value);
    },
  };
  let compiled;
  if (sourcePlan) {
    const declaration = Stack(
      "synthetic",
      {
        providers: LiveContainerProvider(),
        state: Layer.succeed(State, Effect.succeed(state)),
      },
      Effect.gen(function* () {
        const env = yield* fleetInfrastructure;
        return yield* Cloudflare.Worker("PoolWorker", {
          main: import.meta.filename,
          env: { ...env },
        });
      }),
    );
    compiled = yield* evalStack(declaration, Effect.succeed, { stage: "production" }).pipe(
      Effect.provide(
        ConfigProvider.layer(
          ConfigProvider.fromEnv({
            env: {
              POOL_FLEET_IMAGES: JSON.stringify({
                blue: props.image,
                green: props.image,
              }),
            },
          }),
        ),
      ),
      withReleaseRuntime,
    );
  }
  const adapter = sourcePlan
    ? undefined
    : yield* runtimeProvisioningProvider({
        manifest: f.manifest,
        enable: f.enable,
        scriptName: script,
        plan,
        active: async () => f.manifest.active,
        now: () => 100,
      }).pipe(Effect.provideService(State, Effect.succeed(state)));
  const invoke = () =>
    sourcePlan
      ? provisionDeclaredRuntime(compiled, {
          manifest: f.manifest,
          enable: f.enable,
          scriptName: script,
          store,
          active: async () => f.manifest.active,
          now: () => 100,
        }).pipe(Effect.provideService(State, Effect.succeed(state)))
      : Effect.promise(() => provisionRuntime(f.manifest, store, adapter, f.enable, () => 100));
  const receipt = yield* invoke();
  assert.equal(receipt.applicationId, "new-application");
  assert.equal(receipt.disposition, "idle");
  assert.deepEqual(yield* invoke(), receipt);
});
const outcome = await Effect.runPromise(
  Effect.exit(program).pipe(
    Effect.provide(LiveContainerProvider()),
    Retry.none,
    Effect.provideService(HttpClient.HttpClient, client),
    Effect.provideService(
      Credentials,
      Effect.succeed({
        type: "apiToken",
        apiToken: Redacted.make("synthetic-only"),
        apiBaseUrl: "https://api.cloudflare.com/client/v4",
      }),
    ),
    Effect.provideService(CloudflareEnvironment, Effect.succeed({ accountId: account })),
    Effect.provideService(AlchemyContext, { dotAlchemy: root, dev: false, adopt: false }),
    Effect.provideService(FileSystem.FileSystem, FileSystem.makeNoop({})),
    Effect.provide(Path.layer),
    Effect.provideService(Docker, new Proxy({}, { get: () => () => Effect.die("DOCKER DENIED") })),
    Effect.provideService(StackContext, { name: "synthetic", stage: "production" }),
    Effect.provideService(Stage, "production"),
    Effect.provideService(InstanceId, f.manifest.declaration.instanceId),
    Effect.provide(ConfigProvider.layer(ConfigProvider.fromEnv({ env: {} }))),
  ),
);
if (sourceDrift) {
  assert.equal(outcome._tag, "Failure");
  assert.deepEqual(calls, [], "source drift must refuse before namespace reads or writes");
  assert.deepEqual(stateRows.synthetic.production.PoolContainer, legacy);
  console.log("__PROVISIONING_SOURCE_REFUSED_BEFORE_IO__");
  process.exit(0);
}
assert.equal(outcome._tag, "Success", outcome._tag === "Failure" ? String(outcome.cause) : "");
assert.deepEqual(stateRows.synthetic.production.PoolContainer, legacy);
if (sourcePlan)
  assert.deepEqual(stateRows.synthetic.production[resource].downstream, ["PoolWorker"]);
assert.deepEqual(
  calls.filter((call) => call.method !== "GET"),
  [
    { method: "POST", path: `${base}/workers/workers/${script}/versions` },
    { method: "POST", path: `${base}/workers/scripts/${script}/deployments` },
    { method: "POST", path: `${base}/containers/applications` },
  ],
);
console.log("__PROVISIONING_FULL_FLOW_PASS__");
