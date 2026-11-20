import { Effect, Schema } from "effect";
import { decodeProviderApplication } from "../../src/pool/runtime-provider/application.ts";
import type { FleetApplication } from "../../src/pool/runtime-fleet/configuration.ts";
import { refuse } from "./errors.ts";
import { runtimeApplicationConfigDigest } from "./runtime-slot-manifest.ts";

/** The pins the controller holds for an application, from its recorded attributes. */
function runtimeApplicationPins(
  application: Parameters<typeof runtimeApplicationConfigDigest>[0] & {
    readonly accountId: string;
    readonly applicationId: string;
    readonly durableObjects: { readonly namespaceId: string };
    readonly version: number | string;
    readonly configuration: { readonly image: string };
  },
  imageInput: string,
) {
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

// Lenient: only the fields the controller's observation compares are checked here, so a refusal
// names the field instead of failing on an unrelated addition.
const Resolved = Schema.Struct({
  id: Schema.String,
  account_id: Schema.String,
  version: Schema.Number,
  configuration: Schema.Struct({ image: Schema.String }),
  durable_objects: Schema.optional(Schema.NullOr(Schema.Struct({ namespace_id: Schema.String }))),
  active_rollout_id: Schema.optional(Schema.NullOr(Schema.String)),
});

/**
 * Pins for one colour, computed by the decoder the controller runs on every observation
 * (src/pool/runtime-provider/read.ts prove()), so the digest sent is the digest it compares.
 */
export const applicationPins = (
  color: FleetApplication["color"],
  applicationId: string,
  imageInput: string,
  raw: unknown,
) =>
  Effect.gen(function* () {
    const where = `PoolRuntime${color === "blue" ? "Blue" : "Green"} application`;
    const resolved = yield* Effect.try({
      try: () => Schema.decodeUnknownSync(Resolved)(raw),
      catch: () =>
        refuse(
          "application-shape",
          `${where} read-back lacks one of id, account_id, version, configuration.image.`,
          "Capture the live read-back and update scripts/pool-fleet/pins.ts.",
        ),
    });
    if (resolved.id !== applicationId)
      return yield* Effect.fail(
        refuse(
          "application-id-drift",
          `${where} read-back id differs from the PoolWorker binding for ${color}.`,
          "Redeploy PoolWorker so its POOL_*_APPLICATION_ID bindings name the live applications.",
        ),
      );
    if (!resolved.durable_objects?.namespace_id)
      return yield* Effect.fail(
        refuse(
          "application-namespace-missing",
          `${where} read-back has no durable_objects.namespace_id, so it is not attached to its class.`,
          "Redeploy PoolWorker; Alchemy attaches the application to its Durable Object class.",
        ),
      );
    if (!/@sha256:[a-f0-9]{64}$/u.test(resolved.configuration.image))
      return yield* Effect.fail(
        refuse(
          "application-image-unpinned",
          `${where} configuration.image has no @sha256 digest.`,
          "Wait for the image push to finish, then rerun.",
        ),
      );
    if (resolved.active_rollout_id)
      return yield* Effect.fail(
        refuse(
          "application-rollout-active",
          `${where} has active_rollout_id set; the controller refuses to observe a rolling application.`,
          "Wait for the rollout to finish, then rerun.",
        ),
      );
    const attributes = yield* Effect.try({
      try: () => decodeProviderApplication(raw),
      catch: () =>
        refuse(
          "application-controller-decode",
          `${where} read-back is refused by the controller's own decoder (src/pool/runtime-provider/application.ts), so fleet-configure would be refused as provider_observation_refused.`,
          "Capture the read-back; the decoder needs the new field admitted before the fleet can start.",
        ),
    });
    // runtimeApplicationPins reads only identity, version, image and the settings digest.
    const pins = runtimeApplicationPins(
      attributes as Parameters<typeof runtimeApplicationPins>[0],
      imageInput,
    );
    return { color, ...pins } satisfies FleetApplication;
  });
