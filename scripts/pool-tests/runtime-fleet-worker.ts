import { PoolAlarms } from "../../src/pool/alarms.ts";
import { RuntimeFleetState } from "../../src/pool/runtime-fleet/state.ts";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { Schema } from "effect";
import { handoffWorker, runtimeWorkerClasses } from "./runtime-handoff-worker.ts";
import { handoffRuntime } from "./runtime-handoff-fixture.ts";
import { runtimeFixtureCode } from "./runtime-handoff-proofs.ts";
import { runtimeProofFixture } from "../release-barrier/test/runtime-proof-fixture.ts";
import { decodeProviderApplication } from "../../src/pool/runtime-provider/application.ts";
import { runtimeApplicationSettings } from "../../src/pool/runtime-provider/settings.ts";
import { providerDigest } from "../../src/pool/runtime-provider/canonical.ts";
import {
  decodeAdmissionProof,
  runtimeAttestationFormat,
} from "../../src/pool/runtime-slots/admission-proof.ts";
import type { SlotTarget } from "../../src/pool/runtime-slots/contract.ts";
import type {
  FleetApplication,
  FleetConfiguration,
} from "../../src/pool/runtime-fleet/configuration.ts";
import type { HomePeerSource } from "../../src/pool/runtime-slots/peer-access.ts";
import { openEnvelope } from "../../src/pool/token.ts";
import peerProgram from "../../src/pool/home-peer-program.json" with { type: "json" };

type Color = "blue" | "green";
type Runtime = Awaited<ReturnType<typeof handoffRuntime>>;
interface Instance {
  fixture: Runtime;
  worker: InstanceType<(typeof runtimeWorkerClasses)[Color]>;
  color: Color;
}

/** Actual controller and private runtime classes, with only the platform, provider and Home ports doubled. */
export async function fleetWorkerFixture() {
  const original = await runtimeProofFixture();
  const raw = (["blue", "green"] as const).map((color) => ({
    ...structuredClone(original.raw),
    id: `${color}-application`,
    name: `synthetic-${color}`,
    max_instances: 4,
    durable_objects: { namespace_id: `${color}-namespace` },
    configuration: {
      ...original.raw.configuration,
      image: `registry.cloudflare.com/${original.raw.account_id}/synthetic@sha256:${(color === "blue" ? "d" : "f").repeat(64)}`,
    },
  }));
  const applications: FleetApplication[] = await Promise.all(
    raw.map(async (app, index) => ({
      color: index === 0 ? "blue" : "green",
      accountId: app.account_id,
      applicationId: app.id,
      namespaceId: app.durable_objects.namespace_id,
      applicationVersion: String(app.version),
      imageDigest: app.configuration.image.split("@")[1]!,
      imageInput: (index === 0 ? "3" : "4").repeat(16),
      applicationConfigDigest: await providerDigest(
        runtimeApplicationSettings(decodeProviderApplication(app)),
      ),
    })),
  );
  const instances = new Map<string, Instance>();
  const pending = new Map<string, Promise<Instance>>();
  let created: (runtime: Runtime, color: Color) => Promise<void> = async () => {};
  let model: (instance: Runtime, request: Request) => Promise<Response | undefined> = async () =>
    undefined;
  const fetchBefore = globalThis.fetch;
  let providerAvailable = true,
    secretAvailable = true;
  const providerReads: string[] = [];
  let providerRead: () => Promise<void> = async () => {};
  globalThis.fetch = async (input, init) => {
    assert.equal(typeof input, "string");
    const url = new URL(String(input));
    assert.equal(url.origin, "https://api.cloudflare.com");
    assert.equal(init?.method, "GET");
    assert.equal(new Headers(init?.headers).get("authorization"), "Bearer synthetic-provider-read");
    providerReads.push(url.pathname);
    await providerRead();
    if (!providerAvailable) return new Response(null, { status: 403 });
    const app = raw.find(
      (app) =>
        url.pathname ===
          `/client/v4/accounts/${app.account_id}/containers/applications/${app.id}` ||
        url.pathname ===
          `/client/v4/accounts/${app.account_id}/containers/applications/${app.id}/instances-v2`,
    );
    assert.ok(app, "Unexpected provider endpoint");
    return Response.json({
      success: true,
      errors: [],
      result: url.pathname.endsWith("instances-v2")
        ? [...instances.values()]
            .filter(
              (instance) =>
                instance.fixture.target.applicationId === app.id &&
                instance.fixture.ctx.container.running,
            )
            .map((instance) => ({
              id: instance.fixture.target.instanceId,
              application_id: app.id,
              status: { state: "running" },
              image: app.configuration.image,
            }))
        : app,
      result_info: { next_page_token: "" },
    });
  };
  let f: Awaited<ReturnType<typeof handoffWorker>>;
  try {
    f = await handoffWorker({
      bindings: async ({ old, env }) => {
        const namespace = (color: Color) => {
          const application = applications.find((app) => app.color === color)!;
          const get = (id: { toString(): string }) => {
            const instanceId = id.toString();
            const existing = async () => {
              const instance = instances.get(instanceId);
              assert.ok(instance, "Private reads cannot create or warm a runtime");
              return instance;
            };
            return {
              fetch: async (request: Request) => {
                if (!pending.has(instanceId)) {
                  assert.equal(new URL(request.url).pathname, "/admit");
                  const { envelope } = Schema.decodeUnknownSync(
                    Schema.Struct({ envelope: Schema.String }),
                  )(await request.clone().json());
                  const proof = decodeAdmissionProof(
                    await openEnvelope(
                      env.POOL_DEPLOYMENT_KEY!,
                      runtimeAttestationFormat,
                      envelope,
                    ),
                  );
                  assert.equal(proof.target.instanceId, instanceId);
                  assert.equal(proof.target.applicationId, application.applicationId);
                  pending.set(
                    instanceId,
                    (async () => {
                      const runtimeEnv = {
                        ...env,
                        POOL_RUNTIME_APPLICATION_ID: application.applicationId,
                        POOL_IMAGE_HASH: application.imageInput,
                        POOL_BLUE_APPLICATION_ID: applications[0]!.applicationId,
                        POOL_BLUE_IMAGE_HASH: applications[0]!.imageInput,
                        POOL_GREEN_APPLICATION_ID: applications[1]!.applicationId,
                        POOL_GREEN_IMAGE_HASH: applications[1]!.imageInput,
                      };
                      const fixture = await handoffRuntime(proof.target, runtimeEnv, {
                        home: old.home,
                      });
                      fixture.hooks.model = (request) => model(fixture, request);
                      await created(fixture, color);
                      const worker = new runtimeWorkerClasses[color](fixture.ctx, runtimeEnv);
                      const instance = { fixture, worker, color };
                      instances.set(instanceId, instance);
                      return instance;
                    })(),
                  );
                }
                return (await pending.get(instanceId)!).worker.fetch(request);
              },
              homePeerSource: async (target: SlotTarget) =>
                (await existing()).worker.homePeerSource(target),
              assertHomePeer: async (source: HomePeerSource) =>
                (await existing()).worker.assertHomePeer(source),
              openHomePeer: async (source: HomePeerSource) =>
                (await existing()).worker.openHomePeer(source),
            };
          };
          return {
            jurisdiction: (value: string) => {
              assert.equal(value, "eu");
              return {
                get,
                idFromString: (id: string) => id,
                idFromName: (name: string) =>
                  createHash("sha256").update(`${color}:${name}`).digest("hex"),
              };
            },
          };
        };
        old.hooks.model = (request) => model(old, request);
        return {
          PoolRuntime: undefined,
          PoolRuntimeBlue: namespace("blue"),
          PoolRuntimeGreen: namespace("green"),
          POOL_RUNTIME_APPLICATION_ID: applications[0]!.applicationId,
          POOL_BLUE_APPLICATION_ID: applications[0]!.applicationId,
          POOL_BLUE_IMAGE_HASH: applications[0]!.imageInput,
          POOL_GREEN_APPLICATION_ID: applications[1]!.applicationId,
          POOL_GREEN_IMAGE_HASH: applications[1]!.imageInput,
          POOL_PROVIDER_OBSERVATION_TOKEN: {
            get: async () => (secretAvailable ? "synthetic-provider-read" : null),
          },
        };
      },
    });
  } catch (error) {
    globalThis.fetch = fetchBefore;
    throw error;
  }
  const state = new RuntimeFleetState(f.old.storage, 4);
  type Rows = Awaited<ReturnType<typeof state.inspect>>;
  const waiting = new Set<{
    matches(rows: Rows): boolean;
    resolve(rows: Rows): void;
    reject(error: unknown): void;
  }>();
  const observe = () => {
    void state.inspect().then(
      (rows) => {
        for (const waiter of waiting)
          if (waiter.matches(rows)) {
            waiting.delete(waiter);
            waiter.resolve(rows);
          }
      },
      (error) => {
        for (const waiter of waiting) waiter.reject(error);
        waiting.clear();
      },
    );
  };
  const previousCommit = f.old.storage.afterCommit;
  f.old.storage.afterCommit = (keys) => {
    previousCommit(keys);
    if (waiting.size) observe();
  };
  const resourcesWhen = (matches: (rows: Rows) => boolean) =>
    new Promise<Rows>((resolve, reject) => {
      waiting.add({ matches, resolve, reject });
      observe();
    });
  const configuration: FleetConfiguration = {
    format: "pool-runtime-fleet-v1",
    controllerCode: runtimeFixtureCode,
    controllerId: f.old.target.controllerId,
    legacy: f.old.identity(),
    revision: 1,
    previousDigest: null,
    active: "blue",
    applications,
    maximum: 4,
    targetActive: 2,
    idleMilliseconds: 60_000,
  };
  const send = async (action: string, fields: Parameters<typeof f.command>[1] = {}) => {
    const response = await f.command(action, fields);
    assert.equal(response.status, 200, await response.clone().text());
    return Schema.decodeUnknownSync(Schema.Struct({ result: Schema.Unknown }))(
      await response.json(),
    ).result;
  };
  return {
    ...f,
    instances,
    resourcesWhen,
    upkeep: async () => {
      await new PoolAlarms(f.old.storage).schedule("fleet", Date.now());
      await f.alarm();
    },
    applications,
    configuration,
    providerReads,
    send,
    bootstrap: async () =>
      send("peer-bootstrap", {
        operationId: "legacy-peer-bootstrap",
        identity: f.old.identity(),
        sourceSha: peerProgram.sourceSha,
        configurationFingerprint: await f.old.digest(),
      }),
    secretAvailable: (available: boolean) => {
      secretAvailable = available;
    },
    onProviderRead: (hook: typeof providerRead) => {
      providerRead = hook;
    },
    providerAvailable: (available: boolean) => {
      providerAvailable = available;
    },
    onModel: (hook: typeof model) => {
      model = hook;
    },
    onRuntimeCreated: (hook: typeof created) => {
      created = hook;
    },
    settle: () => f.old.settle(),
    cleanup: async () => {
      globalThis.fetch = fetchBefore;
      await f.cleanup();
      for (const instance of instances.values()) await instance.fixture.cleanup();
    },
  };
}
