import * as Containers from "@distilled.cloud/cloudflare/containers";
import * as Retry from "@distilled.cloud/cloudflare/Retry";
import { normalizeNulls } from "alchemy/Util/stable";
import { Config, Effect, Redacted, Schema } from "effect";
import {
  cloudflareResult,
  encodePathSegment,
  withBearer,
  type Fetcher,
} from "../deploy-safety/http.ts";
import { waitForContainerImage } from "../deploy-safety/pool-image.ts";
import { BarrierRefusal } from "./manifest.ts";
import { imageDigest, type ContainerAttributes, type FrozenContainer } from "./container.ts";
import { brand } from "../../brand.ts";
import { applicationCodec } from "./container-schema.ts";
import { verifyContainerHealth } from "./container-health.ts";
import type { PoolOperationsTarget } from "../pool-operations.ts";
import { waitForPoolStatus } from "../pool-readiness.ts";
import { sameContainerState, type ContainerSnapshot } from "./container.ts";

const optional = Schema.optional(Schema.Unknown);
const configuration = Schema.Struct({
  image: Schema.String,
  instance_type: optional,
  vcpu: optional,
  memory: optional,
  memory_mib: optional,
  disk: optional,
  environment_variables: optional,
  secrets: optional,
  labels: optional,
  ports: optional,
  network: optional,
  command: optional,
  entrypoint: optional,
  observability: optional,
  checks: optional,
  dns: optional,
  ssh_public_key_ids: optional,
});
const application = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  account_id: Schema.String,
  version: Schema.Number,
  created_at: Schema.String,
  scheduling_policy: Schema.String,
  instances: Schema.Number,
  max_instances: Schema.Number,
  constraints: optional,
  affinities: optional,
  configuration,
  durable_objects: optional,
  active_rollout_id: Schema.optional(Schema.NullOr(Schema.String)),
  health: optional,
});
const fieldNames: Record<string, string> = {
  account_id: "accountId",
  created_at: "createdAt",
  scheduling_policy: "schedulingPolicy",
  max_instances: "maxInstances",
  durable_objects: "durableObjects",
  namespace_id: "namespaceId",
  instance_type: "instanceType",
  memory_mib: "memoryMib",
  environment_variables: "environmentVariables",
  ssh_public_key_ids: "sshPublicKeyIds",
};

export function containerAttributes(
  value: Containers.GetContainerApplicationResponse,
): ContainerAttributes {
  return {
    applicationId: value.id,
    applicationName: value.name,
    accountId: value.accountId,
    schedulingPolicy: value.schedulingPolicy,
    instances: value.instances,
    maxInstances: value.maxInstances,
    constraints: normalizeNulls(value.constraints) as ContainerAttributes["constraints"],
    affinities: normalizeNulls(value.affinities) as ContainerAttributes["affinities"],
    configuration: normalizeNulls(value.configuration),
    durableObjects: normalizeNulls(value.durableObjects ?? undefined),
    createdAt: value.createdAt,
    version: value.version,
    dev: undefined,
  };
}

/** The SDK drops unknown fields. Inspect raw settings first so a future setting cannot silently disappear from recovery. */
export function decodeApplication(value: unknown) {
  try {
    const raw = Schema.decodeUnknownSync(application, { onExcessProperty: "error" })(value);
    const { active_rollout_id, health: _health, ...settings } = raw;
    const rename = (object: object) =>
      Object.fromEntries(
        Object.entries(object).map(([key, item]) => [fieldNames[key] ?? key, item]),
      );
    const parsed = Schema.decodeUnknownSync(applicationCodec, { onExcessProperty: "error" })({
      ...rename(settings),
      configuration: rename(raw.configuration),
      durableObjects:
        raw.durable_objects == null
          ? undefined
          : rename(
              Schema.decodeUnknownSync(Schema.Struct({ namespace_id: Schema.String }), {
                onExcessProperty: "error",
              })(raw.durable_objects),
            ),
    });
    return {
      ...containerAttributes(parsed),
      ...(active_rollout_id ? { activeRolloutId: active_rollout_id } : {}),
    };
  } catch {
    throw new BarrierRefusal("unsupported-container-observation");
  }
}

export const observeContainer = (
  target: { accountId: string; applicationId: string },
  fetcher: Fetcher = fetch,
) =>
  Effect.gen(function* () {
    const token = yield* Config.Redacted("CLOUDFLARE_API_TOKEN");
    return yield* Effect.tryPromise({
      try: async () => {
        const response = await fetcher(
          `https://api.cloudflare.com/client/v4/accounts/${encodePathSegment(target.accountId)}/containers/applications/${encodePathSegment(target.applicationId)}`,
          {
            method: "GET",
            redirect: "error",
            headers: withBearer(Redacted.value(token)),
            signal: AbortSignal.timeout(15_000),
          },
        );
        if (response.status !== 200 || !response.body) {
          await response.body?.cancel();
          throw new BarrierRefusal("container-observation-failed");
        }
        const reader = response.body.getReader();
        const chunks: Uint8Array[] = [];
        let bytes = 0;
        try {
          while (true) {
            const part = await reader.read();
            if (part.done) break;
            bytes += part.value.byteLength;
            if (bytes > 2_000_000) throw new BarrierRefusal("container-observation-too-large");
            chunks.push(part.value);
          }
        } finally {
          await reader.cancel();
        }
        const result = decodeApplication(
          cloudflareResult(
            JSON.parse(Buffer.concat(chunks).toString("utf8")),
            "container observation",
          ).result,
        );
        if (result.accountId !== target.accountId || result.applicationId !== target.applicationId)
          throw new BarrierRefusal("container-observation-target-drift");
        return result;
      },
      catch: (error) =>
        error instanceof BarrierRefusal
          ? error
          : new BarrierRefusal("container-observation-failed"),
    });
  });

const rolloutReceipt = Schema.Struct({
  id: Schema.String,
  current_version: Schema.Number,
  target_version: Schema.Number,
});
export interface ContainerRollout {
  readonly id: string;
  readonly currentVersion: number;
  readonly targetVersion: number;
}

/** The pinned SDK returns these raw fields but incorrectly declares an Application response. */
export function decodeContainerRollout(value: unknown): ContainerRollout {
  try {
    const receipt = Schema.decodeUnknownSync(rolloutReceipt)(value);
    if (
      !receipt.id.trim() ||
      !Number.isSafeInteger(receipt.current_version) ||
      !Number.isSafeInteger(receipt.target_version) ||
      receipt.target_version <= receipt.current_version
    )
      throw new Error("Invalid rollout versions");
    return {
      id: receipt.id,
      currentVersion: receipt.current_version,
      targetVersion: receipt.target_version,
    };
  } catch {
    throw new BarrierRefusal("container-rollout-unconfirmed");
  }
}

export const waitForContainerVersion = (
  target: ContainerSnapshot,
  rollout: ContainerRollout,
  read = () => observeContainer(target),
) =>
  Effect.gen(function* () {
    const context = yield* Effect.context<Effect.Services<ReturnType<typeof read>>>();
    let result: ContainerAttributes | undefined;
    yield* Effect.tryPromise({
      try: () =>
        waitForPoolStatus("Container rollout version", 200, async () => {
          const current = await Effect.runPromise(read().pipe(Effect.provideContext(context)));
          if (current.activeRolloutId && current.activeRolloutId !== rollout.id)
            throw new BarrierRefusal("container-rollout-drift");
          if (
            current.version !== rollout.currentVersion &&
            current.version !== rollout.targetVersion
          )
            throw new BarrierRefusal("container-version-drift");
          if (
            !sameContainerState(
              {
                ...current,
                version: rollout.targetVersion,
                activeRolloutId: undefined,
                configuration: { ...current.configuration, image: target.configuration.image },
              },
              { ...target, version: rollout.targetVersion },
            )
          )
            throw new BarrierRefusal("container-configuration-drift");
          if (!sameContainerState(current, { ...target, version: rollout.targetVersion })) {
            if (current.version === rollout.targetVersion && !current.activeRolloutId)
              throw new BarrierRefusal("container-configuration-drift");
            return new Response(null, { status: 503 });
          }
          result = current;
          return new Response(null, { status: 200 });
        }),
      catch: (error) =>
        error instanceof BarrierRefusal
          ? error
          : new BarrierRefusal("container-rollout-not-adopted"),
    });
    if (!result) throw new BarrierRefusal("container-rollout-not-adopted");
    return result;
  });

export const rolloutRestoredContainer = (container: FrozenContainer) =>
  Containers.createContainerApplicationRollout({
    accountId: container.baseline.accountId,
    applicationId: container.baseline.applicationId,
    targetConfiguration: structuredClone(container.baseline.configuration),
    strategy: "rolling",
    kind: "full_auto",
    stepPercentage: 100,
    description: "Recorded container recovery",
  }).pipe(Retry.none, Effect.map(decodeContainerRollout));

export const verifyRestoredContainer = (
  container: FrozenContainer,
  worker: PoolOperationsTarget,
  workerImageHash: string,
) =>
  Effect.gen(function* () {
    const token = yield* Config.Redacted("CLOUDFLARE_API_TOKEN");
    return yield* Effect.tryPromise({
      try: async () => {
        const health = await waitForContainerImage(
          {
            applicationId: container.baseline.applicationId,
            accountId: container.baseline.accountId,
            digest: imageDigest(container.baseline.configuration.image),
          },
          { accountId: container.baseline.accountId, apiToken: Redacted.value(token) },
          `https://${brand.host}`,
          fetch,
          {},
          (signal) => verifyContainerHealth(worker, workerImageHash, signal),
        );
        if (!health) throw new BarrierRefusal("container-recovery-runtime-unhealthy");
        return health;
      },
      catch: (error) =>
        error instanceof BarrierRefusal
          ? error
          : new BarrierRefusal("container-recovery-image-not-adopted", container.id),
    });
  });
