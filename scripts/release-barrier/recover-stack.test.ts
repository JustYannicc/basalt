import assert from "node:assert/strict";
import { test } from "node:test";
import { Stack, evalStack } from "alchemy/Stack";
import * as Apply from "alchemy/Apply";
import * as Plan from "alchemy/Plan";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import { inMemoryState } from "alchemy/State/InMemoryState";
import { State } from "alchemy/State/State";
import type { Worker } from "alchemy/Cloudflare";
import { ConfigProvider, Context, Effect, Layer, Redacted } from "effect";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpResponse from "effect/http/HttpClientResponse";
import { Credentials } from "@distilled.cloud/cloudflare/Credentials";
import { recoverStack } from "./recover-stack.ts";
import { withReleaseRuntime } from "./runtime.ts";
import { containerRelease } from "./test/container-fixture.ts";
import { releaseWorkers } from "./barrier.ts";
import { attributes } from "./fixture.ts";
import { readFileSync } from "node:fs";
import { RuntimeRecovery, handleRuntimeRecovery } from "../../src/pool/runtime-recovery.ts";
import { readRuntimeHealth } from "../../src/pool/runtime-health.ts";
import type { RecoveryReceipt } from "./recovery.ts";
import type { ContainerAttributes } from "./container.ts";

interface FixtureWorker extends Resource<"Cloudflare.Worker", {}, Worker["Attributes"]> {}
interface FixtureContainer extends Resource<"Cloudflare.Container", {}, ContainerAttributes> {}
const FixtureWorker = Resource<FixtureWorker>("Cloudflare.Worker");
const FixtureContainer = Resource<FixtureContainer>("Cloudflare.Container");

for (const scenario of [
  "success",
  "foreign-worker",
  "database-unknown",
  "invalid-instances",
  "unhealthy-runtime",
  "missing-runtime-health",
  "initial-baseline-worker",
  "interrupt-after-pool-worker",
] as const)
  test(`public recoverStack uses the SDK and saved container configuration: ${scenario}`, async (context) => {
    const proof = containerRelease();
    let receipt;
    if (scenario === "initial-baseline-worker") {
      const activate = proof.options.provider.activate;
      proof.options.provider.activate = async (worker, version) => {
        await activate(worker, version);
        if (worker.id === "Api") throw new Error("initial activation response lost");
      };
      await assert.rejects(releaseWorkers(proof.manifest, proof.options));
      receipt = proof.receipts.at(-1)!;
    } else receipt = await releaseWorkers(proof.manifest, proof.options);
    const calls: string[] = [];
    const recoveries: RecoveryReceipt[] = [];
    const active = new Map(
      proof.manifest.workers.map((worker) => [
        worker.id,
        proof.active.get(worker.id)![0]!.versionId,
      ]),
    );
    const healthHashes: string[] = [];
    let interruptApi = scenario === "interrupt-after-pool-worker";
    const runtime = new RuntimeRecovery(
      {
        instanceId: "a".repeat(64),
        get imageHash() {
          return active.get("PoolWorker") === "old-PoolWorker"
            ? proof.frozen.baselineInputHash
            : proof.frozen.inputHash;
        },
        running: () => true,
        status: () =>
          readRuntimeHealth(
            {
              fetch: async () =>
                scenario === "unhealthy-runtime"
                  ? new Response(null, { status: 503 })
                  : Response.json({ boot_id: "old-boot", started_at: "2026-01-01T00:00:00Z" }),
            },
            "synthetic-never-sent",
            new AbortController().signal,
          ),
        restart: async () => {
          throw new Error("No restart during recovery health inspection");
        },
      },
      { get: async () => undefined, put: async () => {} },
    );
    if (scenario === "foreign-worker") active.set("Router", "foreign");
    let app = {
      id: "pool-app",
      name: "pool",
      account_id: "fixture",
      version: proof.current().version,
      active_rollout_id: null,
      health: { summary: "healthy", instances: { active: 1, assigned: 1 }, errors: [] },
      created_at: "2026-01-01T00:00:00Z",
      scheduling_policy: "default",
      instances: 1,
      max_instances: 1,
      configuration: { image: proof.current().configuration.image, instance_type: "basic" },
      constraints: { jurisdiction: "eu", regions: ["EEUR", "WEUR"] },
      durable_objects: { namespace_id: "namespace" },
    };
    const envelope = (result: unknown) =>
      Response.json({ success: true, errors: [], messages: [], result });
    const sdk = HttpClient.make((request, url) =>
      Effect.sync(() => {
        const worker = /\/workers\/scripts\/([^/]+)\/deployments$/.exec(url.pathname)?.[1];
        let result: unknown;
        if (worker && request.method === "GET") {
          calls.push(`read:${worker}`);
          result = {
            deployments: [
              {
                id: "deployment",
                created_on: "2026-01-01T00:00:00Z",
                source: "api",
                strategy: "percentage",
                versions: [{ version_id: active.get(worker), percentage: 100 }],
              },
            ],
          };
        } else if (worker && request.method === "POST") {
          assert.equal(request.body._tag, "Uint8Array");
          const body = JSON.parse(Buffer.from(request.body.body).toString());
          assert.deepEqual(body.versions, [{ version_id: `old-${worker}`, percentage: 100 }]);
          assert.equal(body.force, undefined);
          if (worker === "Api" && interruptApi) {
            interruptApi = false;
            calls.push("interrupt:Api");
            throw new Error("synthetic recovery interruption");
          }
          calls.push(`restore:${worker}`);
          active.set(worker, `old-${worker}`);
          result = {
            id: "restored",
            created_on: "2026-01-01T00:00:00Z",
            source: "api",
            strategy: "percentage",
            versions: body.versions,
          };
        } else if (url.pathname.endsWith("/rollouts") && request.method === "POST") {
          assert.equal(request.body._tag, "Uint8Array");
          const body = JSON.parse(Buffer.from(request.body.body).toString());
          assert.equal(body.target_configuration.image, proof.previous.configuration.image);
          calls.push("container:rollout");
          const currentVersion = app.version;
          const previous = app.configuration;
          app = { ...app, configuration: body.target_configuration, version: currentVersion + 1 };
          result = {
            id: "recorded-recovery-rollout",
            current_version: currentVersion,
            target_version: app.version,
            current_configuration: previous,
            target_configuration: app.configuration,
            status: "completed",
          };
        } else throw new Error("Unexpected SDK request in recovery proof");
        return HttpResponse.fromWeb(request, envelope(result));
      }),
    );
    const originalFetch = globalThis.fetch;
    context.after(() => {
      globalThis.fetch = originalFetch;
    });
    globalThis.fetch = async (input, init) => {
      const url = new URL(String(input));
      assert.equal(init?.method ?? "GET", "GET");
      if (url.pathname === "/pool/v1/pool") return new Response(null, { status: 401 });
      if (url.pathname.endsWith("/instances-v2")) {
        calls.push("instances:verified");
        const instance = {
          id: "old-instance",
          application_id: "pool-app",
          image: app.configuration.image,
          status: { state: "running" },
        };
        return Response.json({
          success: true,
          errors: [],
          messages: [],
          result: scenario === "invalid-instances" ? [instance, instance] : [instance],
          result_info: {},
        });
      }
      assert.ok(url.pathname.endsWith("/containers/applications/pool-app"));
      return envelope(app);
    };
    const stack = Stack(
      "basalt",
      {
        state: inMemoryState(),
        providers: Layer.mergeAll(
          Provider.succeed(FixtureWorker, {
            reconcile: ({ id }) => Effect.succeed(attributes(id)),
            delete: () => Effect.void,
          }),
          Provider.succeed(FixtureContainer, {
            reconcile: () => Effect.succeed(proof.current()),
            delete: () => Effect.void,
          }),
        ),
      },
      Effect.gen(function* () {
        for (const id of ["Api", "PoolWorker", "Router"]) yield* FixtureWorker(id, {});
        yield* FixtureContainer("PoolContainer", {});
      }),
    );
    const program = evalStack(
      stack,
      (compiled) =>
        Effect.gen(function* () {
          yield* Apply.apply(yield* Plan.make(compiled));
          const attempt = (previous?: RecoveryReceipt) =>
            recoverStack(
              compiled,
              proof.description,
              receipt,
              async (value) => {
                recoveries.push(value);
              },
              {
                frozen: proof.manifest,
                previous,
                databaseCompatible: scenario !== "database-unknown",
                connect: async (path) => {
                  const config = JSON.parse(readFileSync(path, "utf8"));
                  assert.deepEqual(config.services, [
                    {
                      binding: "POOL_OPERATIONS",
                      service: "PoolWorker",
                      entrypoint: "PoolOperations",
                      remote: true,
                    },
                  ]);
                  return {
                    env: {
                      POOL_OPERATIONS: {
                        fetch: async (request) => {
                          calls.push("health:inspect");
                          assert.equal(request.method, "GET");
                          assert.equal(app.configuration.image, proof.previous.configuration.image);
                          if (scenario === "missing-runtime-health") return Response.json({});
                          return handleRuntimeRecovery(
                            request,
                            {
                              inspectRuntimeRecovery: async (id) => {
                                const value = await runtime.inspect(id);
                                healthHashes.push(value.imageHash);
                                return value;
                              },
                              recoverRuntime: async () => {
                                throw new Error("No runtime mutation");
                              },
                            },
                            "synthetic-never-sent",
                          );
                        },
                      },
                    },
                    dispose: async () => {
                      calls.push("health:closed");
                    },
                  };
                },
              },
            ).pipe(
              Effect.provideService(HttpClient.HttpClient, sdk),
              Effect.provideService(
                Credentials,
                Effect.succeed({
                  type: "apiToken",
                  apiToken: Redacted.make("synthetic-never-sent"),
                  apiBaseUrl: "https://fixture.invalid",
                }),
              ),
              Effect.provide(
                ConfigProvider.layer(
                  ConfigProvider.fromEnv({ env: { CLOUDFLARE_API_TOKEN: "synthetic-never-sent" } }),
                ),
              ),
            );
          if (scenario === "interrupt-after-pool-worker") {
            const interrupted = yield* Effect.exit(attempt());
            assert.equal(interrupted._tag, "Failure");
            assert.equal(active.get("PoolWorker"), "old-PoolWorker");
            assert.equal(active.get("Api"), "new-Api");
            return yield* attempt(recoveries.at(-1));
          }
          return yield* attempt();
        }).pipe(
          Effect.provideContext(compiled.services),
          Effect.provideService(State, Context.get(compiled.services, State)),
        ),
      { stage: "production" },
    ).pipe(withReleaseRuntime);
    if (["success", "initial-baseline-worker", "interrupt-after-pool-worker"].includes(scenario)) {
      await Effect.runPromise(program);
      const rollout = calls.indexOf("container:rollout"),
        verified = calls.indexOf("instances:verified");
      if (scenario === "initial-baseline-worker") assert.equal(rollout, -1);
      else {
        assert.ok(rollout > calls.indexOf("read:Router"));
        assert.ok(verified > rollout);
        assert.equal(calls.filter((call) => call === "container:rollout").length, 1);
      }
      assert.deepEqual(
        calls.filter((call) => call.startsWith("restore:")),
        scenario === "initial-baseline-worker"
          ? ["restore:Api"]
          : ["restore:Router", "restore:PoolWorker", "restore:Api"],
      );
      assert.ok(calls.indexOf("health:inspect") > verified);
      assert.ok(calls.indexOf("restore:Api") > calls.lastIndexOf("health:closed"));
      assert.deepEqual(
        healthHashes,
        scenario === "initial-baseline-worker"
          ? [proof.frozen.baselineInputHash]
          : scenario === "interrupt-after-pool-worker"
            ? [proof.frozen.inputHash, proof.frozen.baselineInputHash]
            : [proof.frozen.inputHash],
      );
      assert.equal(recoveries.at(-1)?.containers?.[0]?.health?.bootId, "old-boot");
      assert.equal(app.configuration.image, proof.previous.configuration.image);
    } else {
      await assert.rejects(Effect.runPromise(program));
      assert.ok(!calls.some((call) => call.startsWith("restore:")));
      if (["foreign-worker", "database-unknown"].includes(scenario))
        assert.ok(!calls.includes("container:rollout"));
    }
  });
