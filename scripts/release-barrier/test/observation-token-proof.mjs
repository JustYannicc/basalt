import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Cause, Redacted, ConfigProvider, Layer } from "effect";
import * as Cloudflare from "alchemy/Cloudflare";
import { Stack, evalStack } from "alchemy/Stack";
import { fleetInfrastructure } from "../../../src/pool/fleet-deployment.ts";
import { withReleaseRuntime } from "../runtime.ts";
import { runDeclaredProvisioning, provisioningOperationDigest } from "../provisioning-operation.ts";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpResponse from "effect/http/HttpClientResponse";
import * as HttpError from "effect/http/HttpClientError";
import { Credentials } from "@distilled.cloud/cloudflare/Credentials";
import * as Retry from "@distilled.cloud/cloudflare/Retry";
import { observationTokenNative } from "../observation-token-native.ts";
import { observationTokenProvider } from "../observation-token-cloudflare.ts";
import { observationTokenDigest, observationTokenProps } from "../observation-token-contract.ts";
import { provisionObservationToken } from "../observation-token-provision.ts";
import { observationTokenClient } from "../observation-token-wire.ts";
import { BarrierRefusal, canonical, digest } from "../manifest.ts";
import { assertSupportedPlan } from "../plan-admission.ts";
const tree = process.argv[2];
const sourceMode = process.argv[3] === "source-operation";
const proofDirectory = sourceMode
  ? mkdtempSync(join(tmpdir(), "observation-token-source-"))
  : "/unused-proof";
if (sourceMode) process.on("exit", () => rmSync(proofDirectory, { recursive: true, force: true }));
const stackName = sourceMode ? "basalt" : "synthetic";
const stage = sourceMode ? "production" : "proof";
const load = (name) =>
  import(
    new URL(
      `../../../node_modules/alchemy/${tree}/${name}.${tree === "src" ? "ts" : "js"}`,
      import.meta.url,
    )
  );
const [
  { AccountApiToken, AccountApiTokenProvider },
  { CloudflareEnvironment },
  { AlchemyContext },
  { StackContext },
  { Stage },
  { InstanceId },
  { InMemoryService },
  { State },
] = await Promise.all([
  load("Cloudflare/ApiToken/AccountApiToken"),
  load("Cloudflare/CloudflareEnvironmentService"),
  load("AlchemyContext"),
  load("StackContext"),
  load("Stage"),
  load("InstanceId"),
  load("State/InMemoryState"),
  load("State/State"),
]);
globalThis.fetch = () => {
  throw new Error("REAL NETWORK DENIED");
};
const account = "1".repeat(32),
  instance = "2".repeat(32),
  fqn = "PoolProviderObservationToken";
const secret = "synthetic-test-token-never-print";
const manifest = {
  format: "pool-observation-token-provisioning-v1",
  candidate: "a".repeat(40),
  stack: stackName,
  stage,
  instanceId: instance,
  accountId: account,
  sdkSourceDigest: digest(
    readFileSync(
      new URL(
        "../../../node_modules/alchemy/src/Cloudflare/ApiToken/AccountApiToken.ts",
        import.meta.url,
      ),
    ),
  ),
  audit: { accountId: account, tokenWriteGranted: true, evidenceDigest: "b".repeat(64) },
};
const props = observationTokenProps(manifest);
const enable = {
  coordinatorGo: "synthetic-only",
  manifest: observationTokenDigest(manifest),
  writerLease: "synthetic-exclusive",
  expiresAt: 1000,
};
function store() {
  let value;
  return {
    exclusive: (work) => work(),
    read: async () => value,
    write: async (record) => {
      assert.equal(JSON.stringify(record).includes(secret), false);
      value = structuredClone(record);
    },
    value: () => value,
  };
}
function wire(options = {}) {
  const calls = [],
    tokens = options.collision ? [{ id: "foreign", name: props.name, status: "active" }] : [];
  const collection = `/client/v4/accounts/${account}/tokens`;
  const client = HttpClient.make((request, url) =>
    Effect.gen(function* () {
      assert.equal(url.origin, "https://api.cloudflare.com");
      calls.push({ method: request.method, path: url.pathname });
      let result;
      if (request.method === "GET" && url.pathname === collection) result = tokens;
      else if (request.method === "GET" && url.pathname === `${collection}/synthetic-token`)
        result = {
          ...tokens[0],
          value: undefined,
          ...(options.readbackDrift
            ? {
                policies: [
                  {
                    id: "policy",
                    effect: "allow",
                    permission_groups: [{ id: "broad-writer" }],
                    resources: { "com.cloudflare.api.account.*": "*" },
                  },
                ],
              }
            : {}),
        };
      else if (request.method === "POST" && url.pathname === collection) {
        assert.equal(request.body._tag, "Uint8Array");
        const body = JSON.parse(new TextDecoder().decode(request.body.body));
        result = {
          id: "synthetic-token",
          status: "active",
          ...body,
          policies: body.policies.map((policy) => ({ id: "policy", ...policy })),
          value: secret,
        };
        tokens.push(result);
        if (options.lost)
          return yield* Effect.fail(
            new HttpError.HttpClientError({ reason: new HttpError.TransportError({ request }) }),
          );
      } else return yield* Effect.die("UNAPPROVED TOKEN WIRE OPERATION");
      return HttpResponse.fromWeb(
        request,
        Response.json({
          success: true,
          errors: [],
          messages: [],
          result,
          ...(request.method === "GET" && url.pathname === collection
            ? {
                result_info: {
                  page: 1,
                  per_page: 50,
                  count: tokens.length,
                  total_count: tokens.length,
                  total_pages: 1,
                },
              }
            : {}),
        }),
      );
    }),
  );
  return { client, calls, tokens };
}
const credentials = Effect.succeed({
  type: "apiToken",
  apiToken: Redacted.make("synthetic-deployer"),
  apiBaseUrl: "https://api.cloudflare.com/client/v4",
});
const services = (effect, w) =>
  effect.pipe(
    Retry.none,
    Effect.provideService(HttpClient.HttpClient, w.client),
    Effect.provideService(Credentials, credentials),
    Effect.provideService(CloudflareEnvironment, Effect.succeed({ accountId: account })),
    Effect.provideService(AlchemyContext, {
      dotAlchemy: proofDirectory,
      dev: false,
      adopt: false,
    }),
    Effect.provideService(StackContext, { name: stackName, stage }),
    Effect.provideService(Stage, stage),
    Effect.provideService(InstanceId, instance),
    Effect.provide(ConfigProvider.layer(ConfigProvider.fromEnv({ env: {} }))),
  );
async function run(w, options = {}) {
  const journal = options.store ?? store();
  const legacy = {
    status: "created",
    fqn: "PoolContainer",
    logicalId: "PoolContainer",
    resourceType: "Cloudflare.Container",
    instanceId: "legacy",
    props: { image: "immutable-legacy" },
    attr: { bootId: "legacy-boot" },
    bindings: [],
    downstream: [],
    providerVersion: 0,
  };
  const rows = options.rows ?? {
    [stackName]: {
      [stage]: {
        PoolContainer: structuredClone(legacy),
        ...(options.prior ? { [fqn]: options.prior } : {}),
      },
    },
  };
  const program = Effect.gen(function* () {
    const provider = yield* AccountApiToken.Provider;
    const memory = yield* InMemoryService(rows);
    const plan = {
      resources: {
        [fqn]: {
          resource: {
            Type: "Cloudflare.ApiToken.AccountApiToken",
            LogicalId: fqn,
            FQN: fqn,
            Props: options.props ?? props,
            Namespace: undefined,
            RemovalPolicy: "retain",
          },
          provider,
          action: "create",
          props: options.props ?? props,
          state: undefined,
          downstream: [],
          bindings: [],
        },
      },
      actions: {},
      deletions: {},
      actionDeletions: {},
      output: undefined,
      cycleMembers: new Set(),
    };
    if (options.ordinary) assertSupportedPlan(plan);
    const actual = options.manifest ?? manifest;
    const gate = options.enable ?? enable;
    let receipt;
    if (sourceMode) {
      const source = Stack(
        stackName,
        {
          providers: AccountApiTokenProvider(),
          state: Layer.succeed(State, Effect.succeed(memory)),
        },
        Effect.gen(function* () {
          const env = yield* fleetInfrastructure;
          return yield* Cloudflare.Worker("PoolWorker", {
            main: import.meta.filename,
            env: { ...env },
          });
        }),
      );
      const compiled = yield* evalStack(source, Effect.succeed, { stage }).pipe(
        Effect.provide(
          ConfigProvider.layer(
            ConfigProvider.fromEnv({
              env: {
                POOL_FLEET_IMAGES: JSON.stringify({
                  blue: `registry.cloudflare.com/${account}/synthetic@sha256:${"a".repeat(64)}`,
                  green: `registry.cloudflare.com/${account}/synthetic@sha256:${"b".repeat(64)}`,
                }),
              },
            }),
          ),
        ),
        withReleaseRuntime,
      );
      const operation = { kind: "observation-token", manifest: actual };
      const packet = {
        operation,
        go: {
          coordinatorGo: gate.coordinatorGo,
          manifest: provisioningOperationDigest(operation),
          expiresAt: gate.expiresAt,
        },
      };
      const writer = {
        candidate: actual.candidate,
        accountId: account,
        lease: "deploy-production:synthetic",
      };
      const invoke = () =>
        runDeclaredProvisioning(compiled, packet, writer, "c".repeat(64), "", {
          now: () => 100,
        }).pipe(Effect.provideService(State, Effect.succeed(memory)));
      assert.equal(compiled.resources[fqn], undefined);
      receipt = yield* invoke();
    } else {
      const privateProvider = yield* observationTokenProvider({
        manifest: actual,
        enable: gate,
        plan,
        now: () => 100,
      }).pipe(Effect.provideService(State, Effect.succeed(memory)));
      receipt = yield* Effect.promise(() =>
        provisionObservationToken(actual, gate, journal, privateProvider, () => 100),
      );
    }
    assert.equal(JSON.stringify(receipt).includes(secret), false);
    const saved = rows[stackName][stage][fqn];
    assert.equal(Redacted.isRedacted(saved.attr.value), true);
    assert.equal(Redacted.value(saved.attr.value), secret);
    const native = yield* observationTokenNative(actual).pipe(
      Effect.provideService(State, Effect.succeed(memory)),
    );
    assert.deepEqual(native, { tokenId: receipt.tokenId, nativeDigest: receipt.nativeDigest });
    return receipt;
  }).pipe(Effect.provide(AccountApiTokenProvider()));
  const exit = await Effect.runPromise(services(Effect.exit(program), w));
  assert.deepEqual(rows[stackName][stage].PoolContainer, legacy);
  return { exit, rows, journal };
}
const count = (w) => w.calls.filter((call) => call.method === "POST").length;
if (sourceMode) {
  const w = wire();
  const refused = await run(w);
  assert.equal(refused.exit._tag, "Failure");
  const failure = Cause.squash(refused.exit.cause);
  assert.ok(failure instanceof BarrierRefusal);
  assert.equal(failure.reason, "provisioning-source-declaration-missing");
  assert.deepEqual(failure.delta.changed, [
    { path: "source.resource", old: digest(canonical(fqn)), new: digest(canonical(null)) },
  ]);
  assert.equal(w.calls.length, 0);
  assert.equal(refused.rows[stackName][stage][fqn], undefined);
  assert.equal(JSON.stringify(refused.rows).includes(secret), false);
  console.log("__OBSERVATION_TOKEN_SOURCE_REFUSAL_PASS__");
  process.exit(0);
}
const normal = wire();
const success = await run(normal);
assert.equal(
  success.exit._tag,
  "Success",
  success.exit._tag === "Failure" ? Cause.pretty(success.exit.cause) : "",
);
assert.equal(count(normal), 1);
assert.equal(
  normal.calls.some((call) => ["PUT", "PATCH", "DELETE"].includes(call.method)),
  false,
);
const lost = wire({ lost: true }),
  retained = store();
assert.equal((await run(lost, { store: retained })).exit._tag, "Failure");
assert.equal(count(lost), 1);
assert.equal(retained.value().operations["token-create"].outcome, "unknown");
const replay = wire();
assert.equal((await run(replay, { store: retained })).exit._tag, "Failure");
assert.equal(count(replay), 0);
for (const [options, wireOptions] of [
  [{ ordinary: true }, {}],
  [
    {
      props: {
        ...props,
        policies: [{ ...props.policies[0], resources: { "com.cloudflare.api.account.*": "*" } }],
      },
    },
    {},
  ],
  [{ enable: { ...enable, coordinatorGo: "" } }, {}],
  [{ enable: { ...enable, expiresAt: 100 } }, {}],
  [{ manifest: { ...manifest, audit: { ...manifest.audit, accountId: "f".repeat(32) } } }, {}],
  [{}, { collision: true }],
]) {
  const w = wire(wireOptions);
  assert.equal((await run(w, options)).exit._tag, "Failure");
  assert.equal(count(w), 0);
}
const drift = wire({ readbackDrift: true });
assert.equal((await run(drift)).exit._tag, "Failure");
assert.equal(count(drift), 1);
// The wire guard also refuses an SDK retry within the same operation.
const repeat = wire();
const repeated = observationTokenClient(repeat.client, manifest, enable, () => 100);
const HttpRequest = await import("effect/http/HttpClientRequest");
const raw = {
  name: props.name,
  policies: props.policies.map((policy) => ({
    effect: policy.effect,
    permission_groups: policy.permissionGroups,
    resources: policy.resources,
  })),
};
const request = HttpRequest.post(
  `https://api.cloudflare.com/client/v4/accounts/${account}/tokens`,
).pipe(HttpRequest.bodyJsonUnsafe(raw));
assert.equal((await Effect.runPromise(Effect.exit(repeated.execute(request))))._tag, "Success");
assert.equal((await Effect.runPromise(Effect.exit(repeated.execute(request))))._tag, "Failure");
assert.equal(count(repeat), 1);
console.log("__OBSERVATION_TOKEN_PROOF_PASS__");
