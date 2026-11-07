import type { PreparedWorkerUpload } from "alchemy/Cloudflare/Workers/WorkerUploadHook";
import type * as Containers from "@distilled.cloud/cloudflare/containers";
import type { ContainerApplication } from "alchemy/Cloudflare";
import {
  equalApplicationSettings,
  equalContainerValues,
  type PreparedContainerPublication,
} from "alchemy/Cloudflare/Containers/ContainerPublicationHook";
import { havePropsChanged } from "alchemy/Diff";
import { Config, Effect, Redacted } from "effect";
import { inspectPoolImage } from "../deploy-safety/pool-image-metadata.ts";
import { BarrierRefusal, canonical, digest } from "./manifest.ts";
import { observeContainer } from "./container-cloudflare.ts";

export type ContainerAttributes = ContainerApplication["Attributes"] & {
  readonly activeRolloutId?: string;
};
export type ContainerSnapshot = Pick<
  ContainerAttributes,
  | "applicationId"
  | "applicationName"
  | "accountId"
  | "version"
  | "configuration"
  | "schedulingPolicy"
  | "maxInstances"
> & {
  readonly constraints?: unknown;
  readonly affinities?: unknown;
  readonly durableObjects?: { namespaceId: string };
};
export interface FrozenContainer {
  readonly id: string;
  readonly baseline: ContainerSnapshot;
  readonly configuration: Readonly<Containers.ContainerConfiguration>;
  readonly rolloutRequest: Readonly<Containers.CreateContainerApplicationRolloutRequest>;
  readonly baselineInputHash: string;
  readonly inputHash: string;
  readonly imageDigest: string;
  readonly imageConfigDigest: string;
  readonly platform: "linux/amd64";
  readonly capabilityLabel: "1";
}
export interface StagedContainer {
  readonly publication: PreparedContainerPublication;
  readonly frozen: FrozenContainer;
}

const digestPattern = /^sha256:[a-f0-9]{64}$/;
export function containerSnapshot(value: ContainerAttributes): ContainerSnapshot {
  return structuredClone({
    applicationId: value.applicationId,
    applicationName: value.applicationName,
    accountId: value.accountId,
    version: value.version,
    configuration: value.configuration,
    schedulingPolicy: value.schedulingPolicy,
    maxInstances: value.maxInstances,
    constraints: value.constraints,
    affinities: value.affinities,
    durableObjects: value.durableObjects,
  });
}

export const describeContainer = (value: FrozenContainer) => ({
  id: value.id,
  target: digest(
    canonical({ accountId: value.baseline.accountId, applicationId: value.baseline.applicationId }),
  ),
  baseline: digest(canonical(value.baseline)),
  baselineVersion: value.baseline.version,
  baselineDigest: imageDigest(value.baseline.configuration.image),
  configuration: digest(canonical(value.configuration)),
  rollout: digest(canonical(value.rolloutRequest)),
  baselineInputHash: value.baselineInputHash,
  inputHash: value.inputHash,
  imageDigest: value.imageDigest,
  imageConfigDigest: value.imageConfigDigest,
  platform: value.platform,
  capabilityLabel: value.capabilityLabel,
});

export function imageDigest(image: string) {
  const value = image.split("@")[1];
  if (!value || !digestPattern.test(value))
    throw new BarrierRefusal("container-image-is-not-immutable");
  return value;
}

export const inspectContainer = (publication: PreparedContainerPublication) =>
  Effect.gen(function* () {
    const observed = yield* observeContainer(publication.previous);
    if (!sameContainerState(observed, containerSnapshot(publication.previous)))
      throw new BarrierRefusal("container-baseline-drift", publication.id);
    const token = yield* Config.Redacted("CLOUDFLARE_API_TOKEN");
    return yield* Effect.tryPromise({
      try: () =>
        inspectPoolImage(
          publication.proposed.configuration.image,
          publication.proposed.hash?.digest ?? "",
          { accountId: publication.previous.accountId, apiToken: Redacted.value(token) },
        ),
      catch: () => new BarrierRefusal("container-image-verification-failed", publication.id),
    });
  });

export function assertImageOnlyPublication(
  publication: PreparedContainerPublication,
  props: ContainerApplication["Props"],
  olds: ContainerApplication["Props"] | undefined,
  cached: ContainerAttributes,
) {
  const { previous, proposed, rolloutRequest } = publication;
  const refuse = (reason: string): never => {
    throw new BarrierRefusal(reason, publication.id);
  };
  if (publication.id !== "PoolContainer" || !olds || havePropsChanged(props, olds))
    refuse("unsupported-container-declaration-change");
  if (
    props.instanceType !== "basic" ||
    props.maxInstances !== 1 ||
    props.instances !== undefined ||
    props.schedulingPolicy !== "default" ||
    props.rollout !== undefined
  )
    refuse("unsupported-container-policy");
  if (canonical(props.constraints) !== canonical({ jurisdiction: "eu", regions: ["EEUR", "WEUR"] }))
    refuse("unsupported-container-placement");
  if (
    previous.accountId !== cached.accountId ||
    previous.applicationId !== cached.applicationId ||
    previous.applicationName !== cached.applicationName ||
    previous.version !== cached.version ||
    !previous.durableObjects?.namespaceId ||
    !equalContainerValues(previous.durableObjects, cached.durableObjects) ||
    !sameContainerState(previous, containerSnapshot(cached))
  )
    refuse("container-baseline-drift");
  if (
    proposed.applicationId !== previous.applicationId ||
    proposed.accountId !== previous.accountId ||
    !equalContainerValues(previous.durableObjects, proposed.durableObjects) ||
    !equalApplicationSettings(previous, props) ||
    !equalApplicationSettings(previous, proposed) ||
    proposed.instances !== previous.instances ||
    !equalContainerValues(
      { ...previous.configuration, image: proposed.configuration.image },
      proposed.configuration,
    ) ||
    rolloutRequest.accountId !== previous.accountId ||
    rolloutRequest.applicationId !== previous.applicationId ||
    !equalContainerValues(rolloutRequest.targetConfiguration, proposed.configuration) ||
    rolloutRequest.kind !== "full_manual" ||
    rolloutRequest.strategy !== "rolling" ||
    rolloutRequest.stepPercentage !== 100
  )
    refuse("unsupported-container-configuration-change");
  const baselineDigest = imageDigest(previous.configuration.image);
  if (
    !/^[a-f0-9]{16}$/.test(previous.hash?.image ?? "") ||
    previous.hash?.digest !== baselineDigest
  )
    refuse("container-baseline-input-unconfirmed");
  const published = imageDigest(proposed.configuration.image);
  const prefix = `registry.cloudflare.com/${previous.accountId}/`;
  if (
    !previous.configuration.image.startsWith(prefix) ||
    !proposed.configuration.image.startsWith(prefix)
  )
    refuse("unsupported-container-registry");
  if (published !== proposed.hash?.digest || !/^[a-f0-9]{16}$/.test(proposed.hash?.image ?? ""))
    refuse("invalid-container-publication");
}

export const stageContainer = (
  publication: PreparedContainerPublication,
  props: ContainerApplication["Props"],
  olds: ContainerApplication["Props"] | undefined,
  cached: ContainerAttributes,
  inspect = inspectContainer,
) =>
  Effect.gen(function* () {
    assertImageOnlyPublication(publication, props, olds, cached);
    yield* publication.verifySource;
    const metadata = yield* inspect(publication);
    if (
      metadata.digest !== publication.proposed.hash?.digest ||
      !digestPattern.test(metadata.configDigest) ||
      metadata.platform !== "linux/amd64" ||
      metadata.capabilityLabel !== "1"
    )
      throw new BarrierRefusal("invalid-container-image-metadata", publication.id);
    const frozen: FrozenContainer = {
      id: publication.id,
      baseline: containerSnapshot(publication.previous),
      configuration: structuredClone(publication.proposed.configuration),
      rolloutRequest: structuredClone(publication.rolloutRequest),
      baselineInputHash: publication.previous.hash!.image!,
      inputHash: publication.proposed.hash!.image!,
      imageDigest: metadata.digest,
      imageConfigDigest: metadata.configDigest,
      platform: "linux/amd64",
      capabilityLabel: "1",
    };
    return { publication, frozen } satisfies StagedContainer;
  });

export function sameContainerState(current: ContainerAttributes, expected: ContainerSnapshot) {
  return (
    current.applicationId === expected.applicationId &&
    current.accountId === expected.accountId &&
    current.applicationName === expected.applicationName &&
    current.version === expected.version &&
    !current.activeRolloutId &&
    equalContainerValues(current.durableObjects, expected.durableObjects) &&
    equalContainerValues(current.configuration, expected.configuration) &&
    equalApplicationSettings(current, expected)
  );
}

export function assertConfiguredContainer(current: ContainerAttributes, frozen: FrozenContainer) {
  if (
    current.applicationId !== frozen.baseline.applicationId ||
    current.accountId !== frozen.baseline.accountId ||
    current.applicationName !== frozen.baseline.applicationName ||
    !Number.isFinite(current.version) ||
    !equalContainerValues(current.durableObjects, frozen.baseline.durableObjects) ||
    !equalContainerValues(current.configuration, frozen.configuration) ||
    !equalApplicationSettings(current, frozen.baseline)
  )
    throw new BarrierRefusal("container-configuration-unconfirmed", frozen.id);
}

/** Pair the saved container input with the actual baseline Worker binding, not its desired new props. */
export function assertBaselineWorkerInput(
  container: FrozenContainer,
  settings: PreparedWorkerUpload["previousSettings"],
) {
  const hashes = settings?.bindings?.filter((binding) => binding.name === "POOL_IMAGE_HASH") ?? [];
  if (
    hashes.length !== 1 ||
    hashes[0]?.type !== "plain_text" ||
    hashes[0].text !== container.baselineInputHash
  )
    throw new BarrierRefusal("container-baseline-worker-input-unconfirmed", "PoolWorker");
}
