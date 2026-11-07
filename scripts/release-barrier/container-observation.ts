import type * as Containers from "@distilled.cloud/cloudflare/containers";
import { normalizeNulls } from "alchemy/Util/stable";
import { Schema } from "effect";
import { applicationCodec } from "./container-schema.ts";
import { unsupportedContainerObservation } from "./container-diagnostics.ts";
import type { ContainerAttributes } from "./container.ts";

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
    const raw = Schema.decodeUnknownSync(application, { onExcessProperty: "error", errors: "all" })(
      value,
    );
    const { active_rollout_id, health: _health, ...settings } = raw;
    const rename = (object: object) =>
      Object.fromEntries(
        Object.entries(object).map(([key, item]) => [fieldNames[key] ?? key, item]),
      );
    const parsed = Schema.decodeUnknownSync(applicationCodec, {
      onExcessProperty: "error",
      errors: "all",
    })({
      ...rename(settings),
      configuration: rename(raw.configuration),
      durableObjects:
        raw.durable_objects == null
          ? undefined
          : rename(
              Schema.decodeUnknownSync(Schema.Struct({ namespace_id: Schema.String }), {
                onExcessProperty: "error",
                errors: "all",
              })(raw.durable_objects),
            ),
    });
    return {
      ...containerAttributes(parsed),
      ...(active_rollout_id ? { activeRolloutId: active_rollout_id } : {}),
    };
  } catch (error) {
    throw unsupportedContainerObservation(error);
  }
}
