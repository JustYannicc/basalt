import { containerDrift } from "./container-diagnostics.ts";
import { configurationCodec, attachmentCodec } from "./container-schema.ts";
import type { PersistedState } from "alchemy/State/State";
import { encodeState } from "alchemy/State/StateEncoding";
import { Schema } from "effect";
import { failureCodec } from "./failure-codec.ts";
import { BarrierRefusal, canonical, digest } from "./manifest.ts";
import {
  containerSnapshot,
  describeContainer,
  imageDigest,
  sameContainerState,
  type ContainerAttributes,
} from "./container.ts";
import {
  readFrozenContainers,
  readRecoveryManifest,
  recoveryReceipt,
} from "./recovery-manifest.ts";

export const encodedRecordHash = (value: unknown) => digest(canonical(encodeState(value)));
const forwardReceipt = Schema.Struct({
  ...recoveryReceipt.fields,
  ceilingMs: Schema.Number,
  phase: Schema.Literals([
    "upload",
    "admitted",
    "schema",
    "baseline",
    "activation",
    "container-activation",
    "complete",
  ]),
  activated: Schema.Array(Schema.Struct({ worker: Schema.String, versionId: Schema.String })),
  pending: Schema.optional(Schema.Struct({ worker: Schema.String, versionId: Schema.String })),
  pendingUpload: Schema.optional(
    Schema.Struct({
      worker: Schema.String,
      versionId: Schema.optional(Schema.String),
      startupTimeMs: Schema.optional(Schema.Number),
    }),
  ),
  failure: Schema.optional(failureCodec),
});
const packet = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  manifest: Schema.Unknown,
  frozen: Schema.Unknown,
  receipt: Schema.Unknown,
  nativeBefore: Schema.Unknown,
  adoption: Schema.optional(
    Schema.Struct({ before: Schema.String, after: Schema.String, backup: Schema.Unknown }),
  ),
});

export function readForwardPacket(value: unknown) {
  const parsed = Schema.decodeUnknownSync(packet, { onExcessProperty: "error" })(value);
  const manifest = readRecoveryManifest(parsed.manifest);
  const frozen = readFrozenContainers(parsed.frozen);
  const receipt = Schema.decodeUnknownSync(forwardReceipt, { onExcessProperty: "error" })(
    parsed.receipt,
  );
  if (
    !("containers" in manifest) ||
    manifest.containers.length !== 1 ||
    frozen.containers.length !== 1 ||
    !["PoolContainer", "PoolRuntimeBlue", "PoolRuntimeGreen"].includes(
      frozen.containers[0]?.id ?? "",
    ) ||
    frozen.candidate !== manifest.candidate ||
    frozen.stack !== manifest.stack ||
    frozen.stage !== manifest.stage ||
    canonical(frozen.containers.map(describeContainer)) !== canonical(manifest.containers) ||
    receipt.manifest !== digest(canonical(manifest)) ||
    receipt.candidate !== manifest.candidate ||
    receipt.schemaVersion !== 2 ||
    new Set(manifest.workers.map((worker) => worker.id)).size !== manifest.workers.length
  )
    throw new BarrierRefusal("forward-journal-mismatch");
  return { ...parsed, manifest, frozen, receipt };
}
export type ForwardPacket = ReturnType<typeof readForwardPacket>;

/** Validate the complete target set before any native record can be adopted. */
export function verifyForwardWorkers(
  packet: ForwardPacket,
  live: ReadonlyMap<
    string,
    {
      target: string;
      versions: readonly { versionId: string; percentage: number }[];
    }
  >,
) {
  if (live.size !== packet.manifest.workers.length)
    throw new BarrierRefusal("forward-worker-coverage");
  for (const worker of packet.manifest.workers) {
    const current = live.get(worker.id);
    const accepted = packet.receipt.accepted.find((item) => item.worker === worker.id);
    if (
      !worker.baseline.length ||
      worker.baseline.some((item) => !item.versionId || item.percentage <= 0) ||
      worker.baseline.reduce((total, item) => total + item.percentage, 0) !== 100
    )
      throw new BarrierRefusal("forward-worker-baseline-invalid", worker.id);
    const baseline = canonical(worker.baseline);
    if (
      !current ||
      current.target !== worker.target ||
      (canonical(current.versions) !== baseline &&
        (!accepted ||
          canonical(current.versions) !==
            canonical([{ versionId: accepted.versionId, percentage: 100 }])))
    )
      throw new BarrierRefusal("forward-worker-drift", worker.id, {
        fqn: worker.id,
        type: "Cloudflare.Worker",
        changed: [
          {
            path: "deployment.versions",
            old: canonical({ baseline: worker.baseline, accepted: accepted?.versionId ?? null }),
            new: canonical(current?.versions ?? null),
          },
          ...(current?.target === worker.target
            ? []
            : [
                {
                  path: "deployment.target",
                  old: worker.target,
                  new: current?.target ?? "missing",
                },
              ]),
        ],
      });
  }
}

export function recordedContainer(saved: PersistedState | undefined, resource = "PoolContainer") {
  if (
    !saved ||
    !("resourceType" in saved) ||
    saved.resourceType !== "Cloudflare.Container" ||
    saved.fqn !== resource ||
    !["PoolContainer", "PoolRuntimeBlue", "PoolRuntimeGreen"].includes(resource) ||
    (saved.status !== "created" && saved.status !== "updated" && saved.status !== "updating") ||
    (saved.status === "updating" && saved.adopting)
  )
    throw new BarrierRefusal("forward-native-record-invalid", "PoolContainer");
  const recorded = saved.status === "updating" ? saved.old : saved;
  const identity = Schema.decodeUnknownSync(
    Schema.Struct({
      applicationId: Schema.String,
      applicationName: Schema.String,
      accountId: Schema.String,
      version: Schema.Number,
      configuration: configurationCodec,
      constraints: Schema.optional(Schema.Unknown),
      affinities: Schema.optional(Schema.Unknown),
      durableObjects: Schema.optional(attachmentCodec),
      schedulingPolicy: Schema.String,
      maxInstances: Schema.Number,
      hash: Schema.Struct({ image: Schema.String, digest: Schema.String }),
    }),
  )(recorded.attr);
  if (!Number.isSafeInteger(identity.version) || identity.version < 1)
    throw new BarrierRefusal("forward-native-record-invalid", "PoolContainer");
  return { saved, recorded, identity };
}

export function forwardAdoption(
  packet: ForwardPacket,
  saved: PersistedState | undefined,
  observed: ContainerAttributes,
) {
  const container = packet.frozen.containers[0]!;
  const { recorded, identity, saved: before } = recordedContainer(saved, container.id);
  const activation = packet.receipt.containers?.find((item) => item.container === container.id);
  const pending = packet.receipt.pendingContainer;
  if (pending?.phase === "rollout")
    throw new BarrierRefusal("forward-rollout-unconfirmed", container.id);
  const isBaseline = sameContainerState(observed, container.baseline);
  const isCandidate =
    activation &&
    (activation.unchanged || activation.rolloutId) &&
    sameContainerState(observed, {
      ...container.baseline,
      version: activation.version,
      configuration: container.configuration,
    });
  if (!isBaseline && !isCandidate)
    throw containerDrift(
      "forward-container-drift",
      activation
        ? {
            ...container.baseline,
            version: activation.version,
            configuration: container.configuration,
          }
        : container.baseline,
      { ...containerSnapshot(observed), activeRolloutId: observed.activeRolloutId },
      container.id,
    );
  const native = containerSnapshot(identity);
  const currentHash = encodedRecordHash(before);
  const nativeBeforeHash = encodedRecordHash(packet.nativeBefore);
  const journaledWrite =
    packet.adoption && [packet.adoption.before, packet.adoption.after].includes(currentHash);
  const alreadyAdopted =
    isCandidate &&
    identity.hash.image === container.inputHash &&
    identity.hash.digest === container.imageDigest &&
    sameContainerState(native, containerSnapshot(observed));
  const unchangedBaseline =
    packet.adoption === undefined &&
    isBaseline &&
    currentHash === nativeBeforeHash &&
    identity.hash.image === container.baselineInputHash &&
    identity.hash.digest === imageDigest(container.baseline.configuration.image);
  if (alreadyAdopted && !journaledWrite && !unchangedBaseline) {
    const hash = (value: string | undefined) =>
      value === undefined ? null : /^[a-f0-9]{64}$/u.test(value) ? value : "invalid";
    throw new BarrierRefusal("forward-native-after-drift", container.id, {
      fqn: container.id,
      type: "Cloudflare.Container",
      changed: [
        { path: "native.recordHash", old: nativeBeforeHash, new: currentHash },
        { path: "journal.adoption.before", old: hash(packet.adoption?.before), new: currentHash },
        { path: "journal.adoption.after", old: hash(packet.adoption?.after), new: currentHash },
      ],
      why: [
        "Candidate identity has neither an exact unchanged native baseline nor a journaled adoption write",
      ],
    });
  }
  if (
    !alreadyAdopted &&
    (identity.hash.image !== container.baselineInputHash ||
      identity.hash.digest !== imageDigest(container.baseline.configuration.image) ||
      !sameContainerState(native, { ...container.baseline, version: identity.version }) ||
      (!journaledWrite && currentHash !== encodedRecordHash(packet.nativeBefore)))
  )
    throw new BarrierRefusal("forward-native-before-drift", container.id);
  const attr = isBaseline
    ? recorded.attr
    : {
        ...recorded.attr,
        ...observed,
        hash: { ...recorded.attr.hash, image: container.inputHash, digest: container.imageDigest },
      };
  const after =
    isBaseline || alreadyAdopted
      ? before
      : before.status === "updating"
        ? { ...before, attr, old: { ...before.old, attr } }
        : { ...before, attr };
  return {
    before,
    after,
    receipt: {
      schemaVersion: 1,
      recordFormat: "alchemy-resource",
      nativeStatus: before.status,
      candidate: packet.manifest.candidate,
      manifest: packet.receipt.manifest,
      before: encodedRecordHash(before),
      after: encodedRecordHash(after),
      disposition: isBaseline ? "baseline" : alreadyAdopted ? "already-adopted" : "adopt-candidate",
      recordedVersion: identity.version,
      liveVersion: observed.version,
      recordedImageHash: identity.hash.image,
      inputHash: isBaseline ? container.baselineInputHash : container.inputHash,
      digest: imageDigest(observed.configuration.image),
      applicationId: observed.applicationId,
      rolloutId: activation?.rolloutId ?? null,
      poolWorker:
        packet.receipt.accepted.find((item) => item.worker === "PoolWorker")?.versionId ?? null,
    },
  };
}
