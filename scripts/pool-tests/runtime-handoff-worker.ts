import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { Schema } from "effect";
import { handoffRuntime } from "./runtime-handoff-fixture.ts";
import { runtimeApplicationFixture } from "./runtime-provider-fixture.ts";
import { runtimeFixtureCode, runtimeGrant, joinedRuntimeProof } from "./runtime-handoff-proofs.ts";
import { StartAuthorization } from "../../src/pool/runtime-slots/admission-proof.ts";
import {
  membershipPath,
  membershipPrefix,
  membershipReadPrefix,
} from "../../src/pool/membership-contract.ts";
import { nativeMembershipKey } from "../../src/pool/runtime-slots/storage.ts";
import type {
  EndpointEnvironment,
  EndpointOptions,
} from "../../src/pool/runtime-slots/endpoint.ts";
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
import type { StartupAbortIntent } from "../../src/pool/runtime-slots/startup-abort-contract.ts";
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
  handlePoolWorkerRequest,
}: {
  handlePoolWorkerRequest: (
    request: Request,
    env: {
      POOL_AUTH_DATABASE: { connectionString: string };
      PoolContainer: {
        jurisdiction(value: string): {
          getByName(name: string): { fetch(request: Request): Promise<Response> };
        };
      };
    },
    lookup: (connection: string, candidates: readonly string[]) => Promise<boolean>,
  ) => Promise<Response>;
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
    candidateTarget?: Partial<SlotTarget>;
    candidateEndpoint?: EndpointOptions;
    candidateProvider?: { accountId: string; namespaceId: string; applicationConfigDigest: string };
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
    ...options.candidateTarget,
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
  const candidate = await handoffRuntime(candidateTarget, nextEnv, {
    home: old.home,
    endpoint: options.candidateEndpoint,
  });
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
  const previousFetch = globalThis.fetch;
  const providerRuntimes = options.candidateProvider ? [old] : [old, candidate];
  globalThis.fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const runtime = providerRuntimes.find(
      (runtime) =>
        url.pathname ===
          `/client/v4/accounts/${"1".repeat(32)}/containers/applications/${runtime.target.applicationId}` ||
        url.pathname ===
          `/client/v4/accounts/${"1".repeat(32)}/containers/applications/${runtime.target.applicationId}/instances-v2`,
    );
    if (url.origin !== "https://api.cloudflare.com" || !runtime) return previousFetch(input, init);
    assert.equal(init?.method, "GET");
    assert.equal(new Headers(init?.headers).get("authorization"), "Bearer synthetic-provider-read");
    const application = runtimeApplicationFixture(runtime.target);
    return Response.json({
      success: true,
      errors: [],
      result: url.pathname.endsWith("instances-v2")
        ? runtime.ctx.container.running
          ? [
              {
                id: runtime.target.instanceId,
                application_id: application.id,
                status: { state: "running" },
                image: application.configuration.image,
              },
            ]
          : []
        : application,
      result_info: { next_page_token: "" },
    });
  };
  const workerEnv = {
    ...env,
    POOL_PROVIDER_OBSERVATION_TOKEN: { get: async () => "synthetic-provider-read" },
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
      intent?: PromotionIntent | StartupAbortIntent;
      operationId?: string;
      identity?: SlotIdentity;
      sourceSha?: string;
      configurationFingerprint?: string;
      configuration?: import("../../src/pool/runtime-fleet/configuration.ts").FleetConfiguration;
      expectedDigest?: string;
      update?: import("../../src/pool/runtime-fleet/image-update.ts").ImageUpdateIntent;
      pool?: string;
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
  const startGrant = () => runtimeGrant(candidate, old.storage, "start", options.candidateProvider);
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
    stage: async (proof: string) => {
      const response = await command("stage", { proof });
      if (!response.ok) return response;
      const grant = Schema.decodeUnknownSync(StartAuthorization)(
        await openEnvelope(old.env.POOL_DEPLOYMENT_KEY!, "pool-runtime-attestation-v1", proof),
      );
      await old.storage.when(`runtime-slots-v1:startup:${grant.target.slotId}`, (value) =>
        Schema.is(Schema.Struct({ status: Schema.Literals(["ready", "failed"]) }))(value),
      );
      const observed = await command("stage-inspect", { target: grant.target });
      const record = Schema.decodeUnknownSync(
        Schema.Struct({
          result: Schema.Struct({
            status: Schema.String,
            identity: Schema.optional(Schema.Unknown),
          }),
        }),
      )(await observed.json()).result;
      return record.status === "ready"
        ? Response.json({ result: record.identity })
        : Response.json({ error: "runtime-startup-failed" }, { status: 409 });
    },
    view,
    model,
    publicModel: (
      request: Request,
      identity: import("../../src/pool/model-membership.ts").ModelIdentity | undefined,
    ) =>
      handlePoolWorkerRequest(
        request,
        {
          POOL_AUTH_DATABASE: { connectionString: "postgresql://fixture@database.invalid/auth" },
          PoolContainer: {
            jurisdiction: (value) => {
              assert.equal(value, "eu");
              return {
                getByName: (name) => {
                  assert.equal(name, "control-plane");
                  return {
                    fetch: (forwarded) =>
                      worker.forward(forwarded, identity ?? { pool: "invalid", person: "invalid" }),
                  };
                },
              };
            },
          },
        },
        async () => identity !== undefined,
      ),
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
    advanceCurrentBindings: (
      bindings: Partial<EndpointEnvironment> & {
        POOL_BLUE_IMAGE_HASH?: string;
        POOL_GREEN_IMAGE_HASH?: string;
      },
    ) => {
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
      globalThis.fetch = previousFetch;
      await old.cleanup();
      await candidate.cleanup();
    },
  };
}
