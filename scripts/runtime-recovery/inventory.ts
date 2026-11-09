import { Schema } from "effect";
import type { Fetcher } from "../deploy-safety/http.ts";
import {
  decodeRecoveryPlan,
  RecoveryWorkflowRefusal,
  type RecoveryPlan,
  type PinDrift,
} from "./plan.ts";

const record = Schema.Record(Schema.String, Schema.Unknown);
const object = Schema.decodeUnknownSync(record);
const positive = (value: unknown) =>
  Schema.decodeUnknownSync(Schema.Number.check(Schema.isGreaterThan(0)))(value);
const string = Schema.decodeUnknownSync(Schema.String);

/** These reads project only target pins; application environment and provider bodies stay private. */
export async function providerPins(plan: RecoveryPlan, token: string, fetcher: Fetcher = fetch) {
  const get = async (path: string) => {
    let response: Response;
    try {
      response = await fetcher(
        `https://api.cloudflare.com/client/v4/accounts/${plan.accountId}/${path}`,
        {
          method: "GET",
          headers: { Authorization: `Bearer ${token}` },
          redirect: "error",
          signal: AbortSignal.timeout(15_000),
        },
      );
      if (!response.ok) {
        await response.body?.cancel();
        throw new RecoveryWorkflowRefusal("inventory-read-failed", [
          {
            resource: path,
            property: "HTTP status",
            expected: "200",
            observed: String(response.status),
          },
        ]);
      }
      if (!response.body) throw new RecoveryWorkflowRefusal("inventory-empty");
      const reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let size = 0;
      try {
        for (;;) {
          const part = await reader.read();
          if (part.done) break;
          size += part.value.byteLength;
          if (size > 2_000_000) throw new RecoveryWorkflowRefusal("inventory-too-large");
          chunks.push(part.value);
        }
      } finally {
        await reader.cancel();
      }
      const envelope = object(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      if (envelope.success !== true) throw new RecoveryWorkflowRefusal("inventory-refused");
      return object(envelope.result);
    } catch (error) {
      if (error instanceof RecoveryWorkflowRefusal) throw error;
      throw new RecoveryWorkflowRefusal("inventory-unavailable");
    }
  };
  try {
    const [application, instance, deployments] = await Promise.all([
      get(`containers/applications/${plan.applicationId}`),
      get(`containers/applications/${plan.applicationId}/instances/${plan.instanceId}`),
      get(`workers/scripts/${plan.worker}/deployments`),
    ]);
    const config = object(application.configuration);
    const versions = Schema.decodeUnknownSync(
      Schema.Array(
        Schema.Struct({
          id: Schema.String,
          created_on: Schema.String,
          versions: Schema.Array(
            Schema.Struct({ version_id: Schema.String, percentage: Schema.Number }),
          ),
        }),
      ),
    )(deployments.deployments);
    const latest = [...versions].sort(
      (a, b) => Date.parse(b.created_on) - Date.parse(a.created_on),
    )[0];
    if (!latest || versions.some((v) => !Number.isFinite(Date.parse(v.created_on))))
      throw new RecoveryWorkflowRefusal("deployment-unavailable");
    if (latest.versions.length !== 1 || latest.versions[0]?.percentage !== 100)
      throw new RecoveryWorkflowRefusal("worker-not-at-100-percent");
    if (application.active_rollout_id != null)
      throw new RecoveryWorkflowRefusal("container-rollout-active");
    if (object(instance.status).state !== "running")
      throw new RecoveryWorkflowRefusal("instance-not-running");
    const image = string(config.image).match(/@(sha256:[a-f0-9]{64})$/)?.[1];
    if (!image) throw new RecoveryWorkflowRefusal("image-digest-unavailable");
    return {
      applicationId: string(application.id),
      applicationVersion: positive(application.version),
      imageDigest: image,
      resources: {
        instanceType: config.instance_type == null ? null : string(config.instance_type),
        vcpu: positive(config.vcpu),
        memoryMiB: positive(config.memory_mib),
        diskMiB: positive(object(config.disk).size_mb),
        maxInstances: positive(application.max_instances),
      },
      instanceId: string(instance.id),
      deploymentId: latest.id,
      workerVersion: latest.versions[0]!.version_id,
    };
  } catch (error) {
    if (error instanceof RecoveryWorkflowRefusal) throw error;
    throw new RecoveryWorkflowRefusal("inventory-invalid");
  }
}

export function pinDrift(expected: RecoveryPlan, observed: RecoveryPlan): PinDrift[] {
  const compare = (
    resource: string,
    property: string,
    left: string | number | null,
    right: string | number | null,
  ): PinDrift[] =>
    left === right ? [] : [{ resource, property, expected: String(left), observed: String(right) }];
  return [
    ...(["deploymentId", "workerVersion", "release"] as const).flatMap((key) =>
      compare(expected.worker, key, expected[key], observed[key]),
    ),
    ...(
      [
        "applicationId",
        "applicationVersion",
        "imageDigest",
        "instanceId",
        "imageHash",
        "bootId",
      ] as const
    ).flatMap((key) => compare(expected.applicationId, key, expected[key], observed[key])),
    ...(["instanceType", "vcpu", "memoryMiB", "diskMiB", "maxInstances"] as const).flatMap((key) =>
      compare(expected.applicationId, key, expected.resources[key], observed.resources[key]),
    ),
  ];
}

export function observedPlan(
  plan: RecoveryPlan,
  provider: Awaited<ReturnType<typeof providerPins>>,
  runtime: unknown,
) {
  try {
    const state = object(runtime);
    if (state.running !== true || state.ready !== true)
      throw new RecoveryWorkflowRefusal("runtime-not-ready");
    if (state.instanceId !== provider.instanceId)
      throw new RecoveryWorkflowRefusal("runtime-instance-mismatch", [
        {
          resource: plan.applicationId,
          property: "instanceId",
          expected: plan.instanceId,
          observed:
            typeof provider.instanceId === "string" && /^[a-f0-9]{64}$/.test(provider.instanceId)
              ? provider.instanceId
              : "unavailable",
        },
      ]);
    return decodeRecoveryPlan({
      ...plan,
      ...provider,
      release: state.release,
      bootId: state.bootId,
      imageHash: state.imageHash,
    });
  } catch (error) {
    if (error instanceof RecoveryWorkflowRefusal) throw error;
    throw new RecoveryWorkflowRefusal("reviewed-recovery-not-supported");
  }
}
