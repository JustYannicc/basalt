import type * as Plan from "alchemy/Plan";
import type { StateService } from "alchemy/State/State";
import type { CompiledStack } from "alchemy/Stack";
import { Config, Effect, Redacted, Schema } from "effect";
import { inspectPoolImage } from "../deploy-safety/pool-image-metadata.ts";
import { imageDigest, type FrozenContainer } from "./container.ts";
import { observeContainer } from "./container-cloudflare.ts";
import { configurationCodec } from "./container-schema.ts";
import { BarrierRefusal } from "./refusal.ts";
import { equalContainerConfiguration } from "./container-configuration.ts";
import type { HomeMigrationIdentity } from "./home-schema-operation.ts";
import type { AdmittedHomeImage } from "./home-schema-container.ts";
import { homeImageMetadataMismatch } from "./home-schema-image-identity.ts";

const cached = Schema.Struct({
  accountId: Schema.String,
  applicationId: Schema.String,
  version: Schema.Number,
  configuration: configurationCodec,
  hash: Schema.Struct({
    image: Schema.String.check(Schema.isPattern(/^[a-f0-9]{16}$/u)),
    digest: Schema.String.check(Schema.isPattern(/^sha256:[a-f0-9]{64}$/u)),
  }),
});
export interface ReleaseHomeImage {
  image: AdmittedHomeImage;
  identity: HomeMigrationIdentity;
  credentials: { accountId: string; apiToken: string };
}

const live = {
  token: Config.Redacted("CLOUDFLARE_API_TOKEN").pipe(Effect.map((token) => Redacted.value(token))),
  observe: observeContainer,
  inspect: inspectPoolImage,
};
export type HomeImageDependencies = typeof live;

function cachedImage(value: unknown) {
  try {
    return Schema.decodeUnknownSync(cached)(value);
  } catch {
    throw new BarrierRefusal("home-schema-candidate-image-unavailable");
  }
}

/** No-change containers still supply the candidate image for schema checks on Worker-only releases. */
export const releaseHomeImage = (
  stack: Pick<CompiledStack, "name" | "stage">,
  candidate: string,
  plan: Plan.Plan,
  state: StateService,
  changed: readonly FrozenContainer[],
  io: HomeImageDependencies = live,
) =>
  Effect.gen(function* () {
    const token = yield* io.token;
    const candidateContainer = changed.find((entry) => entry.id === "PoolContainer");
    if (candidateContainer) {
      const image = {
        image: candidateContainer.configuration.image,
        imageDigest: candidateContainer.imageDigest,
        imageConfigDigest: candidateContainer.imageConfigDigest,
      };
      return {
        image,
        credentials: { accountId: candidateContainer.baseline.accountId, apiToken: token },
        identity: {
          candidate,
          imageDigest: image.imageDigest,
          imageConfigDigest: image.imageConfigDigest,
          baselineImageDigest: imageDigest(candidateContainer.baseline.configuration.image),
          sourceInputHash: candidateContainer.inputHash,
          baselineInputHash: candidateContainer.baselineInputHash,
        },
      } satisfies ReleaseHomeImage;
    }
    const node = plan.resources.PoolContainer;
    if (!node || node.resource.Type !== "Cloudflare.Container" || node.action !== "noop")
      throw new BarrierRefusal("home-schema-candidate-image-unavailable");
    const stored = yield* state.get({
      stack: stack.name,
      stage: stack.stage,
      fqn: "PoolContainer",
    });
    if (
      !stored ||
      !("resourceType" in stored) ||
      stored.resourceType !== "Cloudflare.Container" ||
      stored.fqn !== "PoolContainer" ||
      stored.logicalId !== "PoolContainer" ||
      (stored.status !== "created" && stored.status !== "updated")
    )
      throw new BarrierRefusal("home-schema-candidate-image-unavailable");
    const before = cachedImage(stored.attr);
    const planned = cachedImage(node.state.attr);
    if (
      stored.instanceId !== node.state.instanceId ||
      before.accountId !== planned.accountId ||
      before.applicationId !== planned.applicationId ||
      before.version !== planned.version ||
      before.hash.image !== planned.hash.image ||
      before.hash.digest !== planned.hash.digest ||
      !equalContainerConfiguration(before.configuration, planned.configuration)
    )
      throw new BarrierRefusal("home-schema-baseline-image-drift");
    const current = yield* io.observe(before);
    if (
      current.accountId !== before.accountId ||
      current.applicationId !== before.applicationId ||
      current.version !== before.version ||
      current.activeRolloutId ||
      !equalContainerConfiguration(current.configuration, before.configuration)
    )
      throw new BarrierRefusal("home-schema-baseline-image-drift");
    const digest = imageDigest(before.configuration.image);
    if (digest !== before.hash.digest) throw new BarrierRefusal("home-schema-baseline-image-drift");
    const credentials = { accountId: before.accountId, apiToken: token };
    const metadata = yield* Effect.tryPromise({
      try: () => io.inspect(before.configuration.image, digest, credentials),
      catch: (error) =>
        homeImageMetadataMismatch(error)?.refusal ??
        new BarrierRefusal("home-schema-image-admission-failed"),
    });
    return {
      image: {
        image: before.configuration.image,
        imageDigest: digest,
        imageConfigDigest: metadata.configDigest,
      },
      credentials,
      identity: {
        candidate,
        imageDigest: digest,
        imageConfigDigest: metadata.configDigest,
        baselineImageDigest: digest,
        sourceInputHash: before.hash.image,
        baselineInputHash: before.hash.image,
      },
    } satisfies ReleaseHomeImage;
  });
