import {
  safeInputIdentity,
  workerInputHash,
  type BaselineWorkerSettings,
} from "./serving-worker-input.ts";
import type * as Containers from "@distilled.cloud/cloudflare/containers";
import type { ContainerApplication } from "alchemy/Cloudflare";
import {
  equalApplicationSettings,
  equalContainerValues,
  type PreparedContainerPublication,
} from "alchemy/Cloudflare/Containers/ContainerPublicationHook";
import { containerDeclarationChanged, runtimeImageDeclaration } from "./container-declaration.ts";
import {
  pinnedLegacyDeclaration,
  pinnedRuntimeDeclaration,
  preserveLegacyPublication,
} from "./legacy-image.ts";
import { Config, Effect, Redacted } from "effect";
import { inspectPoolImage } from "../deploy-safety/pool-image-metadata.ts";
import { BarrierRefusal, canonical, digest } from "./manifest.ts";
import { changedProps } from "./prop-diff.ts";
import type { FleetImageResource } from "./runtime-image-phase.ts";
import { observeContainer } from "./container-cloudflare.ts";
import {
  equalContainerConfiguration,
  recoverableConfiguration,
} from "./container-configuration.ts";

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
  readonly preservedSourceInputHash?: string;
}
export interface StagedContainer {
  readonly publication: PreparedContainerPublication;
  readonly frozen: FrozenContainer;
  readonly normalization?: BaselineNormalization;
}
export interface BaselineNormalization {
  readonly disposition: "observed-baseline";
  readonly recordedVersion: number;
  readonly observedVersion: number;
  readonly imageDigest: string;
  readonly changed: ReturnType<typeof changedProps>;
}

const digestPattern = /^sha256:[a-f0-9]{64}$/;
export function containerSnapshot(value: ContainerSnapshot): ContainerSnapshot {
  return structuredClone({
    applicationId: value.applicationId,
    applicationName: value.applicationName,
    accountId: value.accountId,
    version: value.version,
    configuration: recoverableConfiguration(value.configuration),
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
  ...(value.preservedSourceInputHash
    ? { preservedSourceInputHash: value.preservedSourceInputHash }
    : {}),
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
      throw new BarrierRefusal("container-baseline-drift", publication.id, {
        fqn: publication.id,
        type: "Cloudflare.Container",
        changed: changedProps(containerSnapshot(publication.previous), observed),
      });
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
  runtimeImage?: FleetImageResource,
) {
  const previous: ContainerAttributes = publication.previous;
  const { proposed, rolloutRequest } = publication;
  const fleet =
    publication.id === runtimeImage ||
    (olds &&
      ["PoolRuntimeBlue", "PoolRuntimeGreen"].includes(publication.id) &&
      "image" in props &&
      props.image === previous.configuration.image &&
      runtimeImageDeclaration(props, olds));
  const retainedRuntime =
    publication.id === "PoolRuntime" &&
    olds?.className === "PoolRuntime" &&
    props.className === "PoolRuntime" &&
    pinnedRuntimeDeclaration(props, olds, previous.configuration.image) &&
    equalContainerConfiguration(previous.configuration, proposed.configuration);
  const refuse = (reason: string, expected: unknown, actual: unknown): never => {
    throw new BarrierRefusal(reason, publication.id, {
      fqn: publication.id,
      type: "Cloudflare.Container",
      changed: changedProps(expected, actual),
    });
  };
  if (
    (publication.id !== "PoolContainer" && !fleet && !retainedRuntime) ||
    !olds ||
    (containerDeclarationChanged(props, olds) &&
      !pinnedLegacyDeclaration(props, olds, publication.previous.configuration.image) &&
      !(fleet && runtimeImageDeclaration(props, olds)) &&
      !retainedRuntime)
  )
    refuse("unsupported-container-declaration-change", olds, props);
  if (
    props.instanceType !== "basic" ||
    (fleet && (props.className !== publication.id || olds?.className !== publication.id)) ||
    props.maxInstances !== (fleet ? 4 : 1) ||
    props.instances !== (fleet || retainedRuntime ? 0 : undefined) ||
    props.schedulingPolicy !== "default" ||
    props.rollout !== undefined
  )
    refuse(
      "unsupported-container-policy",
      {
        instanceType: "basic",
        maxInstances: fleet ? 4 : 1,
        instances: fleet || retainedRuntime ? 0 : undefined,
        className: publication.id,
        schedulingPolicy: "default",
      },
      {
        instanceType: props.instanceType,
        maxInstances: props.maxInstances,
        instances: props.instances,
        schedulingPolicy: props.schedulingPolicy,
        rollout: props.rollout,
      },
    );
  if (canonical(props.constraints) !== canonical({ jurisdiction: "eu", regions: ["EEUR", "WEUR"] }))
    refuse(
      "unsupported-container-placement",
      { constraints: { jurisdiction: "eu", regions: ["EEUR", "WEUR"] } },
      { constraints: props.constraints },
    );
  if (
    previous.accountId !== cached.accountId ||
    previous.applicationId !== cached.applicationId ||
    previous.applicationName !== cached.applicationName ||
    !Number.isSafeInteger(cached.version) ||
    cached.version < 1 ||
    !Number.isSafeInteger(previous.version) ||
    (previous.version !== cached.version && previous.version !== cached.version + 1) ||
    !previous.durableObjects?.namespaceId ||
    !equalContainerValues(previous.durableObjects, cached.durableObjects) ||
    !sameContainerState({ ...previous, version: cached.version }, containerSnapshot(cached))
  )
    refuse("container-baseline-drift", containerSnapshot(cached), {
      ...containerSnapshot(previous),
      ...(previous.activeRolloutId ? { activeRolloutId: previous.activeRolloutId } : {}),
    });
  if (
    proposed.applicationId !== previous.applicationId ||
    proposed.accountId !== previous.accountId ||
    !equalContainerValues(previous.durableObjects, proposed.durableObjects) ||
    !equalApplicationSettings(previous, props) ||
    !equalApplicationSettings(previous, proposed) ||
    proposed.instances !== previous.instances ||
    !equalContainerConfiguration(
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
    refuse(
      "unsupported-container-configuration-change",
      {
        ...containerSnapshot(previous),
        instances: previous.instances,
        configuration: { ...previous.configuration, image: proposed.configuration.image },
        rolloutRequest: {
          ...rolloutRequest,
          accountId: previous.accountId,
          applicationId: previous.applicationId,
          targetConfiguration: proposed.configuration,
          kind: "full_manual",
          strategy: "rolling",
          stepPercentage: 100,
        },
      },
      { ...containerSnapshot(proposed), instances: proposed.instances, rolloutRequest },
    );
  const baselineDigest = imageDigest(previous.configuration.image);
  if (
    !/^[a-f0-9]{16}$/.test(previous.hash?.image ?? "") ||
    previous.hash?.digest !== baselineDigest
  )
    refuse(
      "container-baseline-input-unconfirmed",
      { hash: { image: cached.hash?.image, digest: baselineDigest } },
      { hash: previous.hash },
    );
  if (cached.hash?.digest !== baselineDigest || cached.hash?.image !== previous.hash?.image)
    refuse("container-baseline-input-unconfirmed", { hash: cached.hash }, { hash: previous.hash });
  const published = imageDigest(proposed.configuration.image);
  const prefix = `registry.cloudflare.com/${previous.accountId}/`;
  if (
    !previous.configuration.image.startsWith(prefix) ||
    !proposed.configuration.image.startsWith(prefix)
  )
    refuse(
      "unsupported-container-registry",
      { image: previous.configuration.image },
      { image: proposed.configuration.image },
    );
  if (published !== proposed.hash?.digest || !/^[a-f0-9]{16}$/.test(proposed.hash?.image ?? ""))
    refuse(
      "invalid-container-publication",
      { hash: { digest: published } },
      { hash: proposed.hash },
    );
}

export const stageContainer = (
  publication: PreparedContainerPublication,
  props: ContainerApplication["Props"],
  olds: ContainerApplication["Props"] | undefined,
  cached: ContainerAttributes,
  inspect = inspectContainer,
  runtimeImage?: FleetImageResource,
) =>
  Effect.gen(function* () {
    const preservation = preserveLegacyPublication(publication, props, olds);
    const candidate = preservation.publication;
    assertImageOnlyPublication(candidate, props, olds, cached, runtimeImage);
    yield* candidate.verifySource;
    const metadata = yield* inspect(candidate);
    if (
      metadata.digest !== candidate.proposed.hash?.digest ||
      !digestPattern.test(metadata.configDigest) ||
      metadata.platform !== "linux/amd64" ||
      metadata.capabilityLabel !== "1"
    )
      throw new BarrierRefusal("invalid-container-image-metadata", candidate.id);
    const frozen: FrozenContainer = {
      id: candidate.id,
      baseline: containerSnapshot(candidate.previous),
      configuration: structuredClone(candidate.proposed.configuration),
      rolloutRequest: structuredClone(candidate.rolloutRequest),
      baselineInputHash: candidate.previous.hash!.image!,
      inputHash: candidate.proposed.hash!.image!,
      imageDigest: metadata.digest,
      imageConfigDigest: metadata.configDigest,
      platform: "linux/amd64",
      capabilityLabel: "1",
      ...(preservation.preservedSourceInputHash
        ? { preservedSourceInputHash: preservation.preservedSourceInputHash }
        : {}),
    };
    const changed = changedProps(
      { ...containerSnapshot(cached), configuration: cached.configuration },
      {
        ...containerSnapshot(candidate.previous),
        configuration: candidate.previous.configuration,
      },
    );
    return {
      publication: candidate,
      frozen,
      ...(changed.length
        ? {
            normalization: {
              disposition: "observed-baseline" as const,
              recordedVersion: cached.version,
              observedVersion: candidate.previous.version,
              imageDigest: imageDigest(cached.configuration.image),
              changed,
            },
          }
        : {}),
    } satisfies StagedContainer;
  });

export function sameContainerState(
  current: ContainerSnapshot & { activeRolloutId?: string },
  expected: ContainerSnapshot,
) {
  return (
    current.applicationId === expected.applicationId &&
    current.accountId === expected.accountId &&
    current.applicationName === expected.applicationName &&
    current.version === expected.version &&
    !current.activeRolloutId &&
    equalContainerValues(current.durableObjects, expected.durableObjects) &&
    equalContainerConfiguration(current.configuration, expected.configuration) &&
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
    !equalContainerConfiguration(current.configuration, frozen.configuration) ||
    !equalApplicationSettings(current, frozen.baseline)
  )
    throw new BarrierRefusal("container-configuration-unconfirmed", frozen.id, {
      fqn: frozen.id,
      type: "Cloudflare.Container",
      changed: changedProps(
        { ...frozen.baseline, configuration: frozen.configuration, version: current.version },
        containerSnapshot(current),
      ),
    });
}

/** Pair the saved container input with the actual baseline Worker binding, not its desired new props. */
export function assertBaselineWorkerInput(
  container: Pick<FrozenContainer, "baselineInputHash">,
  settings: BaselineWorkerSettings | undefined,
) {
  const observed = workerInputHash(settings);
  if (!observed || observed !== container.baselineInputHash) {
    const refusal = new BarrierRefusal(
      "container-baseline-worker-input-unconfirmed",
      "PoolWorker",
      {
        fqn: "PoolWorker",
        type: "Cloudflare.Worker",
        changed: [
          {
            path: "bindings.POOL_IMAGE_HASH",
            old: safeInputIdentity(container.baselineInputHash),
            new: safeInputIdentity(observed),
          },
        ],
      },
    );
    refusal.message += `: bindings.POOL_IMAGE_HASH expected=${safeInputIdentity(container.baselineInputHash)} observed=${safeInputIdentity(observed)}`;
    throw refusal;
  }
}
