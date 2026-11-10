import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { test } from "node:test";
import { poolDatabase } from "./database-settings.ts";
import { configurationDigest, runtimeConfiguration } from "./runtime-slots/configuration.ts";
import { runtimeAttestationFormat } from "./runtime-slots/admission-proof.ts";
import { RuntimeSlotStorage, type SlotStorage } from "./runtime-slots/storage.ts";
import { deploymentReadinessPrefix } from "./deployment-readiness.ts";
import { signEnvelope } from "./token.ts";
import { policyHealthHeader } from "./runtime-health.ts";

const hooks = registerHooks({
  resolve(specifier, context, next) {
    if (specifier === "cloudflare:workers")
      return {
        url: "data:text/javascript,export class DurableObject { constructor(ctx, env) { this.ctx = ctx; this.env = env; } } export class WorkerEntrypoint {}",
        shortCircuit: true,
      };
    if (specifier === "pg")
      return {
        url: "data:text/javascript,export default { Client: class { on() {} async connect() {} async query() { return { rows: [] }; } async end() {} } }",
        shortCircuit: true,
      };
    return next(specifier, context);
  },
});
const workerModule = "./worker.ts";
const {
  PoolContainer,
}: {
  PoolContainer: new (
    ctx: object,
    env: object,
  ) => {
    deploymentReady(): Promise<{ bootId: string }>;
    deploymentIdentity(): { candidate: string; workerInput: string };
    runtimeHandoff(request: Request): Promise<Response>;
    fetch(request: Request): Promise<Response>;
  };
} = await import(workerModule);
hooks.deregister();

test("explicit unattested-active preservation keeps the provider boot without a second start or a proven-readiness claim", async () => {
  const instanceId = "a".repeat(64);
  const env = {
    POOL_DATABASE_URL: "postgresql://fixture@database.invalid/pool",
    POOL_MANAGEMENT_KEY: "fixture-management",
    POOL_APP_SIGNING_KEY: "ab".repeat(32),
    POOL_IMAGE_HASH: "2".repeat(16),
    POOL_DEPLOYMENT_KEY: "c".repeat(64),
    POOL_CONTAINER_APPLICATION_ID: "legacy-application",
    POOL_RUNTIME_APPLICATION_ID: "candidate-application",
    PoolRuntime: { jurisdiction: () => ({ get: () => {} }) },
  };
  const revision = Buffer.from(
    await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(
        JSON.stringify([
          env.POOL_DATABASE_URL,
          env.POOL_MANAGEMENT_KEY,
          "1".repeat(16),
          env.POOL_APP_SIGNING_KEY,
          null,
          poolDatabase.owner,
        ]),
      ),
    ),
  ).toString("hex");
  const identity = {
    format: "pool-runtime-slot-v1",
    controllerId: instanceId,
    slotId: "legacy",
    applicationId: "legacy-application",
    applicationVersion: "31",
    instanceId,
    imageDigest: `sha256:${"b".repeat(64)}`,
    imageInput: env.POOL_IMAGE_HASH,
    bootId: "provider-boot",
  };
  const values = new Map<string, unknown>([
    ["revision", revision],
    ["ready-revision", revision],
  ]);
  let starts = 1;
  let destroys = 0;
  let running = true;
  let boot = identity.bootId;
  const storage = {
    get: async <T>(key: string) => structuredClone(values.get(key)) as T | undefined,
    put: async (key: string, value: unknown) => {
      values.set(key, structuredClone(value));
    },
    transaction: async <T>(work: (transaction: SlotStorage) => Promise<T>) => work(storage),
    getAlarm: async () => null,
    setAlarm: async () => {},
  };
  const ctx = {
    id: { toString: () => instanceId },
    storage,
    waitUntil: () => {},
    container: {
      get running() {
        return running;
      },
      start() {
        starts++;
        running = true;
        boot = `unnecessary-boot-${starts}`;
      },
      async destroy() {
        destroys++;
        running = false;
      },
      setInactivityTimeout: async () => {},
      getTcpPort(port: number) {
        return {
          fetch: async () =>
            port === 8318
              ? Response.json(
                  { boot_id: boot, started_at: "2026-11-09T20:11:04Z" },
                  { headers: { [policyHealthHeader]: "1500" } },
                )
              : Response.json({ data: [{ id: "selected-runtime-model" }] }),
        };
      },
    },
  };
  const worker = new PoolContainer(ctx, env);
  const { candidate, workerInput } = worker.deploymentIdentity();
  const code = { candidate, workerInput };
  const snapshot = await new RuntimeSlotStorage(storage).inspect(),
    now = Date.now();
  const proof = {
    format: runtimeAttestationFormat,
    kind: "unattested-active",
    operationId: crypto.randomUUID(),
    manifestDigest: "d".repeat(64),
    controllerCode: code,
    target: { ...identity, bootId: undefined },
    configurationFingerprint: await configurationDigest(runtimeConfiguration(env)),
    selection: { expectedEpoch: 0, active: null, policyDigest: snapshot.digest, revisions: [] },
    provider: {
      accountId: "fixture-account",
      namespaceId: "fixture-namespace",
      applicationId: identity.applicationId,
      applicationVersion: identity.applicationVersion,
      instanceId,
      imageDigest: identity.imageDigest,
      applicationConfigDigest: "e".repeat(64),
      observationDigest: "f".repeat(64),
      observedAt: now,
    },
    bootId: identity.bootId,
    at: now,
    expiresAt: now + 60_000,
  };
  const preservation = await worker.runtimeHandoff(
    new Request("http://operations/runtime-handoff", {
      method: "POST",
      body: JSON.stringify({
        envelope: await signEnvelope(env.POOL_DEPLOYMENT_KEY, deploymentReadinessPrefix, {
          controllerCode: code,
          action: "adopt",
          proof: await signEnvelope(env.POOL_DEPLOYMENT_KEY, runtimeAttestationFormat, proof),
          at: now,
          expiresAt: now + 60_000,
        }),
      }),
    }),
  );
  assert.equal(preservation.status, 200, await preservation.clone().text());
  await assert.rejects(worker.deploymentReady(), /Unattested active runtime/u);
  assert.equal((await worker.fetch(new Request("https://pool.invalid/__warm"))).status, 204);
  assert.equal(destroys, 0, "New controller code must not destroy the selected running boot");
  assert.equal(starts, 1, "The provider rollout's start is the release's only start");
  const response = await worker.fetch(new Request("https://pool.invalid/v1/models"));
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("X-Signalbox-Pool-Boot"), identity.bootId);
  assert.deepEqual(await response.json(), { data: [{ id: "selected-runtime-model" }] });
});
