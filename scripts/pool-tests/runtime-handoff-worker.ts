import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { Schema } from "effect";
import { handoffRuntime } from "./runtime-handoff-fixture.ts";
import { runtimeFixtureCode, runtimeGrant, joinedRuntimeProof } from "./runtime-handoff-proofs.ts";
import { StartAuthorization } from "../../src/pool/runtime-slots/admission-proof.ts";
import {
  membershipPath,
  membershipPrefix,
  membershipReadPrefix,
} from "../../src/pool/membership-contract.ts";
import { nativeMembershipKey } from "../../src/pool/runtime-slots/storage.ts";
import type { EndpointEnvironment } from "../../src/pool/runtime-slots/endpoint.ts";
import { deploymentReadinessPrefix } from "../../src/pool/deployment-readiness.ts";
import { openEnvelope, signEnvelope, signPoolToken } from "../../src/pool/token.ts";
import type {
  PromotionIntent,
  SlotSelection,
  SlotTarget,
  SlotIdentity,
} from "../../src/pool/runtime-slots/contract.ts";
import type { PoolView } from "../../apps/pool/contract.ts";
import type { RuntimeStub } from "../../src/pool/runtime-slots/transport.ts";
import type { HomePeerEndpoint } from "../../src/pool/runtime-fleet/peers.ts";
type RuntimeWorker = RuntimeStub & HomePeerEndpoint & { alarm(): Promise<void> };
import type { ProbeResult } from "../../src/pool/availability.ts";

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
const workerPath = "../../src/pool/worker.ts";
const {
  PoolContainer,
  PoolRuntimeBlue,
  PoolRuntimeGreen,
}: {
  PoolRuntimeBlue: new (ctx: object, env: object) => RuntimeWorker;
  PoolRuntimeGreen: new (ctx: object, env: object) => RuntimeWorker;
  PoolContainer: new (
    ctx: object,
    env: object,
  ) => {
    fetch(request: Request): Promise<Response>;
    alarm(): Promise<void>;
    runtimeHandoff(request: Request): Promise<Response>;
    deploymentReady(): Promise<{ bootId: string; instanceId: string }>;
    availabilityProbe(pool: string): Promise<ProbeResult>;
    automaticRecoveryObservation(pool: string): Promise<unknown>;
    forward(request: Request, identity: { pool: string; person: string }): Promise<Response>;
  };
} = await import(workerPath);
hooks.deregister();

export const runtimeWorkerClasses = { blue: PoolRuntimeBlue, green: PoolRuntimeGreen };
type RuntimeFixture = Awaited<ReturnType<typeof handoffRuntime>>;
export async function handoffWorker(
  options: {
    rotateSigningKey?: boolean;
    adopt?: boolean;
    bindings?:
      | Record<string, unknown>
      | ((context: {
          old: RuntimeFixture;
          candidate: RuntimeFixture;
          env: EndpointEnvironment;
        }) => Promise<Record<string, unknown>>);
  } = {},
) {
  const oldTarget: SlotTarget = {
    format: "pool-runtime-slot-v1",
    controllerId: "a".repeat(64),
    slotId: "legacy",
    applicationId: "legacy-app",
    applicationVersion: "1",
    instanceId: "a".repeat(64),
    imageDigest: `sha256:${"b".repeat(64)}`,
    imageInput: "1".repeat(16),
  };
  const candidateTarget: SlotTarget = {
    ...oldTarget,
    slotId: "candidate",
    applicationId: "candidate-app",
    applicationVersion: "2",
    instanceId: "c".repeat(64),
    imageDigest: `sha256:${"d".repeat(64)}`,
    imageInput: "2".repeat(16),
  };
  const env = {
    POOL_DATABASE_URL: "postgresql://fixture@database.invalid/pool",
    POOL_MANAGEMENT_KEY: "fixture-old-key",
    POOL_APP_SIGNING_KEY: "ab".repeat(32),
    POOL_IMAGE_HASH: oldTarget.imageInput,
    POOL_DEPLOYMENT_KEY: "e".repeat(64),
    POOL_CONTAINER_APPLICATION_ID: oldTarget.applicationId,
    POOL_RUNTIME_APPLICATION_ID: candidateTarget.applicationId,
  };
  const old = await handoffRuntime(oldTarget, env, { running: true, role: "legacy" });
  const nextEnv = {
    ...env,
    POOL_IMAGE_HASH: candidateTarget.imageInput,
    POOL_MANAGEMENT_KEY: "fixture-new-key",
    ...(options.rotateSigningKey
      ? {
          POOL_APP_SIGNING_KEY: "cd".repeat(32),
          POOL_APP_SIGNING_KEY_PREVIOUS: env.POOL_APP_SIGNING_KEY,
        }
      : {}),
  };
  const candidate = await handoffRuntime(candidateTarget, nextEnv, { home: old.home });
  const claims = { pool: "pool-a", owner: "fixture-owner", organization: "fixture-organization" };
  const now = Date.now();
  const policy = {
    pool: claims.pool,
    organization: claims.organization,
    revision: 1,
    expiresAt: now + 12_000,
    accounts: ["auth-a"],
    dirty: false,
  };
  await old.storage.put(nativeMembershipKey, {
    [claims.pool]: {
      ...policy,
      native: true,
      checkedAt: now,
      installedRevision: 1,
      installedUntil: policy.expiresAt,
    },
    "retired-pool": {
      ...policy,
      pool: "retired-pool",
      revision: 4,
      accounts: [],
      dirty: true,
      retired: { resumeAfter: now },
      expiresAt: now - 1,
      native: true,
    },
  });
  await old.storage.put("pool-directory-v1", {
    pools: {
      [JSON.stringify(claims.pool)]: {
        ...claims,
        name: "Fixture pool",
        users: [claims.owner],
        managers: [claims.owner],
        authorization: "executor-app-v1",
        ownerSource: "audience",
        pending: [],
        provisioned: [],
        at: now,
      },
    },
    refusals: {},
    people: {},
    refusalsVersion: 2,
  });
  let loseStartReply = false;
  const bindings =
    typeof options.bindings === "function"
      ? await options.bindings({ old, candidate, env: nextEnv })
      : options.bindings;
  const workerEnv = {
    ...env,
    PoolRuntime: {
      jurisdiction: () => ({
        idFromString: (id: string) => id,
        get: (id: string) => {
          assert.equal(id, candidateTarget.instanceId);
          return {
            fetch: async (request: Request) => {
              const response = await candidate.stub.fetch(request);
              if (loseStartReply && new URL(request.url).pathname === "/start") {
                loseStartReply = false;
                throw new Error("lost candidate start reply");
              }
              return response;
            },
          };
        },
      }),
    },
    TOOLS_SERVICE: {
      fetch: async (input: string, init?: RequestInit) => {
        if (new URL(input).pathname === "/api/internal/pool-organization")
          return new Response(null, { status: 204 });
        const { envelope } = Schema.decodeUnknownSync(Schema.Struct({ envelope: Schema.String }))(
          JSON.parse(String(init?.body)),
        );
        const assertion = Schema.decodeUnknownSync(
          Schema.Struct({ pool: Schema.String, organization: Schema.String }),
        )(
          await openEnvelope(
            nextEnv.POOL_APP_SIGNING_KEY,
            membershipReadPrefix,
            envelope,
            env.POOL_APP_SIGNING_KEY,
          ),
        );
        return Response.json({
          ...assertion,
          native: true,
          accounts: [
            {
              account: "saved-account",
              requirement: "model",
              provider: "openai",
              method: "secret",
              generation: 1,
              driver: "home",
              driverRevision: "1",
              bindingRevision: "1",
              homeReference: "auth-a",
            },
          ],
        });
      },
    },
    ...bindings,
  };
  let worker = new PoolContainer(old.ctx, workerEnv);
  const command = async (
    action: string,
    fields: {
      proof?: string;
      target?: SlotTarget;
      intent?: PromotionIntent;
      operationId?: string;
      identity?: SlotIdentity;
      sourceSha?: string;
      configurationFingerprint?: string;
      configuration?: import("../../src/pool/runtime-fleet/configuration.ts").FleetConfiguration;
      expectedDigest?: string;
    } = {},
  ) => {
    const at = Date.now();
    return worker.runtimeHandoff(
      new Request("http://operations/runtime-handoff", {
        method: "POST",
        body: JSON.stringify({
          envelope: await signEnvelope(env.POOL_DEPLOYMENT_KEY, deploymentReadinessPrefix, {
            controllerCode: runtimeFixtureCode,
            action,
            ...fields,
            at,
            expiresAt: at + 60_000,
          }),
        }),
      }),
    );
  };
  const preservation = await runtimeGrant(old, old.storage, "unattested-active");
  let adoptionAck: unknown;
  if (options.adopt !== false) {
    const adopted = await command("adopt", { proof: preservation.envelope });
    assert.equal(adopted.status, 200, await adopted.clone().text());
    adoptionAck = await adopted.json();
  }
  let currentEnv = { ...workerEnv, ...(options.adopt === false ? {} : nextEnv), ...bindings };
  // Model and Home requests keep the admitted runtime settings after current bindings advance.
  worker = new PoolContainer(old.ctx, currentEnv);
  const token = await signPoolToken(env.POOL_APP_SIGNING_KEY, claims);
  const view = async (fresh = true) => {
    const response = await worker.fetch(
      new Request(`https://pool.invalid/pool/v1/pool${fresh ? "?fresh=true" : ""}`, {
        headers: { authorization: `Bearer ${token}`, "x-signalbox-caller": claims.owner },
      }),
    );
    return { response, body: (await response.json()) as PoolView };
  };
  const model = (request = new Request("https://pool.invalid/v1/models")) =>
    worker.forward(request, {
      pool: claims.pool,
      person: claims.owner,
    });
  const reserve = async () =>
    worker.fetch(
      new Request(`https://pool.invalid${membershipPath}`, {
        method: "POST",
        body: JSON.stringify({
          envelope: await signEnvelope(env.POOL_APP_SIGNING_KEY, membershipPrefix, {
            pool: claims.pool,
            organization: claims.organization,
            at: Date.now(),
            expiresAt: Date.now() + 30_000,
          }),
        }),
      }),
    );
  const inspect = async () => {
    const response = await command("inspect");
    assert.equal(response.status, 200);
    return ((await response.json()) as { result: { selection: SlotSelection; digest: string } })
      .result;
  };
  const startGrant = () => runtimeGrant(candidate, old.storage, "start");
  const joined = (grant: Awaited<ReturnType<typeof startGrant>>) =>
    joinedRuntimeProof(
      candidate,
      old.storage,
      Schema.decodeUnknownSync(StartAuthorization)(grant.proof),
    );
  const intent = async (): Promise<PromotionIntent> => {
    const snapshot = await inspect();
    return {
      operationId: crypto.randomUUID(),
      controllerCode: runtimeFixtureCode,
      expectedEpoch: snapshot.selection.epoch,
      previous: snapshot.selection.active.identity!,
      candidate: snapshot.selection.candidate!.identity!,
      policyDigest: snapshot.digest,
    };
  };
  return {
    old,
    candidate,
    preservation,
    adoptionAck,
    claims,
    policy,
    worker,
    command,
    view,
    model,
    alarm: async () => {
      await old.storage.delete("fixture-alarm");
      return worker.alarm();
    },
    reserve,
    inspect,
    startGrant,
    joined,
    intent,
    loseStartReply: () => {
      loseStartReply = true;
    },
    advanceCurrentBindings: (bindings: Partial<EndpointEnvironment>) => {
      currentEnv = { ...currentEnv, ...bindings };
      worker = new PoolContainer(old.ctx, currentEnv);
      return worker;
    },
    reconstruct: (bound = true) => {
      worker = new PoolContainer(old.ctx, {
        ...currentEnv,
        ...(!bound ? { PoolRuntime: undefined } : {}),
      });
      return worker;
    },
    cleanup: async () => {
      await old.cleanup();
      await candidate.cleanup();
    },
  };
}
