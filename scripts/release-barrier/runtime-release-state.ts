import { State } from "alchemy/State/State";
import type { CompiledStack } from "alchemy/Stack";
import { Effect, Redacted, Schema } from "effect";
import { retainedRuntimeImage } from "../../src/pool/legacy-image.ts";
import {
  runtimeConfiguration,
  RuntimeConfiguration,
} from "../../src/pool/runtime-slots/configuration.ts";
import { CreatedRuntimeApplication } from "./provisioning-apply.ts";
import { BarrierRefusal } from "./refusal.ts";
import { runtimeApplicationConfigDigest } from "./runtime-slot-provider-proof.ts";

const Application = Schema.Struct({
  ...CreatedRuntimeApplication.fields,
  instances: Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0)),
  hash: Schema.Struct({
    image: Schema.String,
    digest: Schema.String,
    configuration: Schema.optional(Schema.String),
  }),
});
const Worker = Schema.Struct({
  accountId: Schema.NonEmptyString,
  workerName: Schema.NonEmptyString,
});
const Props = Schema.Struct({ env: Schema.Record(Schema.String, Schema.Unknown) });
export type RuntimeReleaseApplication = typeof Application.Type;
const RetainedApplication = Schema.Struct({
  resource: Schema.Literals([
    "PoolContainer",
    "PoolRuntime",
    "PoolRuntimeBlue",
    "PoolRuntimeGreen",
  ]),
  image: Schema.Struct({
    image: Schema.String,
    inputHash: Schema.String,
    digest: Schema.String,
    applicationId: Schema.String,
  }),
  attributes: Application,
  instanceId: Schema.String,
  props: Schema.Record(Schema.String, Schema.Unknown),
});
export const RuntimeReleaseState = Schema.Struct({
  target: Schema.Struct({ worker: Schema.String, accountId: Schema.String }),
  applications: Schema.Struct({
    root: RetainedApplication,
    legacy: Schema.optional(RetainedApplication),
    blue: Schema.optional(RetainedApplication),
    green: Schema.optional(RetainedApplication),
  }),
  configuration: RuntimeConfiguration,
  deploymentKey: Schema.String,
  monitorPool: Schema.optional(Schema.String),
});
export type RuntimeReleaseState = typeof RuntimeReleaseState.Type;

/** Read native provenance, retaining secret values only in the in-process configuration capsule. */
export const runtimeReleaseState = (stack: Pick<CompiledStack, "name" | "stage">) =>
  Effect.gen(function* () {
    const state = yield* yield* State;
    const read = (fqn: string) => state.get({ stack: stack.name, stage: stack.stage, fqn });
    const worker = yield* read("PoolWorker");
    if (
      !worker ||
      (worker.status !== "created" && worker.status !== "updated") ||
      worker.resourceType !== "Cloudflare.Worker"
    )
      throw new BarrierRefusal("runtime-release-native-Worker-unsettled", "PoolWorker");
    const target = Schema.decodeUnknownSync(Worker)(worker.attr);
    const env = Schema.decodeUnknownSync(Props)(worker.props).env;
    const value = (key: string, optional = false) => {
      const raw = env[key],
        text = Redacted.isRedacted(raw) ? Redacted.value(raw) : raw;
      if (typeof text === "string" && text) return text;
      if (optional && text === undefined) return undefined;
      throw new BarrierRefusal(
        "runtime-release-native-setting-unavailable",
        `PoolWorker.env.${key}`,
      );
    };
    const configuration = runtimeConfiguration({
      POOL_DATABASE_URL: value("POOL_DATABASE_URL")!,
      POOL_MANAGEMENT_KEY: value("POOL_MANAGEMENT_KEY")!,
      POOL_APP_SIGNING_KEY: value("POOL_APP_SIGNING_KEY")!,
      POOL_APP_SIGNING_KEY_PREVIOUS: value("POOL_APP_SIGNING_KEY_PREVIOUS", true),
      POOL_CLAUDE_QUOTA_DIAGNOSTIC: value("POOL_CLAUDE_QUOTA_DIAGNOSTIC", true),
      POOL_IMAGE_HASH: value("POOL_IMAGE_HASH")!,
    });
    const applications: Partial<
      Record<
        "root" | "legacy" | "blue" | "green",
        {
          resource: "PoolContainer" | "PoolRuntime" | "PoolRuntimeBlue" | "PoolRuntimeGreen";
          image: NonNullable<ReturnType<typeof retainedRuntimeImage>>;
          attributes: RuntimeReleaseApplication;
          instanceId: string;
          props: Record<string, unknown>;
        }
      >
    > = {};
    for (const [color, resource] of [
      ["root", "PoolContainer"],
      ["legacy", "PoolRuntime"],
      ["blue", "PoolRuntimeBlue"],
      ["green", "PoolRuntimeGreen"],
    ] as const) {
      const row = yield* read(resource);
      if (!row) continue;
      if (
        (row.status !== "created" && row.status !== "updated") ||
        row.resourceType !== "Cloudflare.Container"
      )
        throw new BarrierRefusal("runtime-release-native-application-unsettled", resource);
      const image = retainedRuntimeImage(row, resource);
      if (!image) throw new BarrierRefusal("runtime-release-native-image-unavailable", resource);
      const attributes = Schema.decodeUnknownSync(Application)(row.attr);
      if (attributes.accountId !== target.accountId || !attributes.durableObjects.namespaceId)
        throw new BarrierRefusal("runtime-release-native-application-mismatch", resource);
      applications[color] = {
        resource,
        image,
        attributes,
        instanceId: row.instanceId,
        props: row.props,
      };
    }
    if (!applications.root)
      throw new BarrierRefusal("runtime-release-native-Root-missing", "PoolContainer");
    return Schema.decodeUnknownSync(RuntimeReleaseState)({
      target: { worker: target.workerName, accountId: target.accountId },
      applications,
      configuration,
      deploymentKey: value("POOL_DEPLOYMENT_KEY")!,
      monitorPool: value("POOL_AVAILABILITY_TARGET", true),
    });
  });

export function runtimeApplicationPins(application: RuntimeReleaseApplication, imageInput: string) {
  return {
    accountId: application.accountId,
    applicationId: application.applicationId,
    namespaceId: application.durableObjects.namespaceId,
    applicationVersion: String(application.version),
    imageDigest: application.configuration.image.split("@")[1]!,
    imageInput,
    applicationConfigDigest: runtimeApplicationConfigDigest(application),
  };
}
