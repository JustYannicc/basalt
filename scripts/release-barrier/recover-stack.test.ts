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
import { containerRelease } from "./container-fixture.ts";
import { releaseWorkers } from "./barrier.ts";
import { attributes } from "./fixture.ts";
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
] as const)
  test(`public recoverStack uses the SDK and saved container configuration: ${scenario}`, async (context) => {
    const proof = containerRelease();
    const receipt = await releaseWorkers(proof.manifest, proof.options);
    const calls: string[] = [];
    const active = new Map(proof.manifest.workers.map((worker) => [worker.id, `new-${worker.id}`]));
    if (scenario === "foreign-worker") active.set("Router", "foreign");
    let app = {
      id: "pool-app",
      name: "pool",
      account_id: "fixture",
      version: 2,
      active_rollout_id: null,
      health: { summary: "healthy", instances: { active: 1, assigned: 1 }, errors: [] },
      created_at: "2026-01-01T00:00:00Z",
      scheduling_policy: "default",
      instances: 1,
      max_instances: 1,
      configuration: { image: proof.proposed.configuration.image, instance_type: "basic" },
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
          return yield* recoverStack(compiled, proof.description, receipt, async () => {}, {
            frozen: proof.manifest,
            databaseCompatible: scenario !== "database-unknown",
          }).pipe(
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
        }).pipe(
          Effect.provideContext(compiled.services),
          Effect.provideService(State, Context.get(compiled.services, State)),
        ),
      { stage: "production" },
    ).pipe(withReleaseRuntime);
    if (scenario === "success") {
      await Effect.runPromise(program);
      const rollout = calls.indexOf("container:rollout"),
        verified = calls.indexOf("instances:verified");
      assert.ok(rollout > calls.indexOf("read:Router"));
      assert.ok(verified > rollout);
      assert.deepEqual(
        calls.filter((call) => call.startsWith("restore:")),
        ["restore:Router", "restore:PoolWorker", "restore:Api"],
      );
      assert.ok(calls.indexOf("restore:Router") > verified);
      assert.equal(app.configuration.image, proof.previous.configuration.image);
    } else {
      await assert.rejects(Effect.runPromise(program));
      assert.ok(!calls.some((call) => call.startsWith("restore:")));
      if (scenario !== "invalid-instances") assert.ok(!calls.includes("container:rollout"));
    }
  });
