import { ReleaseOperationFailure } from "./operation-failure.ts";
import { assertSqlSchemas, type SqlSchemaReceipt } from "./sql-schema-contract.ts";
import { uploadFailure } from "./upload-failure.ts";
import type { ResourceDelta } from "./prop-diff.ts";
import {
  BarrierRefusal,
  canonical,
  manifestDigest,
  snapshotManifest,
  type FrozenWorker,
  type ReleaseManifest,
} from "./manifest.ts";
import {
  assertConfiguredContainer,
  containerSnapshot,
  sameContainerState,
  type ContainerAttributes,
  type FrozenContainer,
} from "./container.ts";
import { equalContainerConfiguration } from "./container-configuration.ts";
import { containerDrift } from "./container-diagnostics.ts";
import type { ContainerRollout } from "./container-cloudflare.ts";

export interface ContainerVersionProvider {
  verifySource(container: FrozenContainer): Promise<void>;
  read(container: FrozenContainer): Promise<ContainerAttributes>;
  rollout(container: FrozenContainer): Promise<ContainerRollout>;
  advance(container: FrozenContainer, rollout: ContainerRollout): Promise<void>;
  verify(container: FrozenContainer, observed: ContainerAttributes): Promise<void>;
  wait(container: FrozenContainer, rollout: ContainerRollout): Promise<ContainerAttributes>;
}

export interface VersionProvider {
  upload(
    worker: FrozenWorker,
  ): Promise<{ versionId?: string | null; startupTimeMs?: number | null }>;
  baseline(worker: FrozenWorker): Promise<FrozenWorker["baseline"]>;
  activate(worker: FrozenWorker, versionId: string): Promise<void>;
}

export interface BarrierReceipt {
  schemaVersion: 1 | 2;
  candidate: string;
  manifest: string;
  ceilingMs: number;
  phase:
    | "upload"
    | "admitted"
    | "schema"
    | "baseline"
    | "activation"
    | "container-activation"
    | "complete";
  sqlSchemas?: SqlSchemaReceipt;
  accepted: { worker: string; versionId: string; startupTimeMs: number }[];
  startupMeasurements?: { worker: string; versionId: string; startupTimeMs: number }[];
  activated: { worker: string; versionId: string }[];
  pending?: { worker: string; versionId: string };
  pendingUpload?: { worker: string; versionId?: string; startupTimeMs?: number };
  containers?: {
    container: string;
    version: number;
    rolloutId?: string;
    unchanged?: boolean;
    promoted?: boolean;
  }[];
  pendingContainer?: {
    container: string;
    phase: "rollout" | "advance" | "verification";
    version?: number;
    rolloutId?: string;
  };
  failure?: {
    reason: string;
    worker?: string;
    delta?: ResourceDelta;
    operation?: ReleaseOperationFailure["operation"];
    provider?: ReleaseOperationFailure["provider"];
  };
}

export interface BarrierOptions {
  provider: VersionProvider;
  containers?: ContainerVersionProvider;
  record(receipt: BarrierReceipt): Promise<void>;
  beforeActivate?(): Promise<void>;
  sqlSchemas?(record: (receipt: SqlSchemaReceipt) => Promise<void>): Promise<SqlSchemaReceipt>;
  ceilingMs?: number;
}

/** Admission is complete before any caller can activate a version. */
export async function releaseWorkers(
  input: ReleaseManifest,
  options: BarrierOptions,
): Promise<BarrierReceipt> {
  const manifest = snapshotManifest(input);
  const ceilingMs = options.ceilingMs ?? 750;
  if (!Number.isFinite(ceilingMs) || ceilingMs <= 0 || ceilingMs > 750)
    throw new BarrierRefusal("invalid-ceiling");
  const fingerprint = manifestDigest(manifest);
  const receipt: BarrierReceipt = {
    schemaVersion: manifest.schemaVersion ?? 1,
    candidate: manifest.candidate,
    manifest: fingerprint,
    ceilingMs,
    phase: "upload",
    accepted: [],
    startupMeasurements: [],
    activated: [],
    ...(manifest.schemaVersion === 2 ? { containers: [] } : {}),
  };
  const record = () => options.record(structuredClone(receipt));
  const unchanged = () => {
    if (manifestDigest(manifest) !== fingerprint || manifestDigest(input) !== fingerprint)
      throw new BarrierRefusal("manifest-drift");
  };
  try {
    await record();
    if (manifest.containers?.length && !options.containers)
      throw new BarrierRefusal("missing-container-provider");
    for (const container of manifest.containers ?? [])
      await options.containers!.verifySource(container);
    for (const worker of manifest.workers) {
      for (let attempt = 0; attempt < 2; attempt++) {
        unchanged();
        receipt.pendingUpload = { worker: worker.id };
        await record();
        let uploaded;
        try {
          uploaded = await options.provider.upload(worker);
        } catch (error) {
          throw uploadFailure(error, worker.id);
        }
        receipt.pendingUpload = {
          worker: worker.id,
          ...(uploaded.versionId ? { versionId: uploaded.versionId } : {}),
          ...(typeof uploaded.startupTimeMs === "number" && Number.isFinite(uploaded.startupTimeMs)
            ? { startupTimeMs: uploaded.startupTimeMs }
            : {}),
        };
        if (!uploaded.versionId?.trim()) throw new BarrierRefusal("missing-version-id", worker.id);
        const startup = uploaded.startupTimeMs;
        if (typeof startup !== "number" || !Number.isFinite(startup) || startup < 0)
          throw new BarrierRefusal("missing-or-invalid-startup-evidence", worker.id);
        const measurement = {
          worker: worker.id,
          versionId: uploaded.versionId,
          startupTimeMs: startup,
        };
        receipt.startupMeasurements!.push(measurement);
        await record();
        if (startup > ceilingMs) {
          // Provider startup measurements vary even for identical uploads. Confirm once without activation.
          if (attempt === 0) continue;
          throw new BarrierRefusal("startup-headroom", worker.id);
        }
        receipt.accepted.push(measurement);
        delete receipt.pendingUpload;
        await record();
        break;
      }
    }
    unchanged();
    receipt.phase = "admitted";
    await record();
    // The database phase can run only after every Worker has provider acceptance.
    await options.beforeActivate?.();
    receipt.phase = "schema";
    await record();
    if (!options.sqlSchemas) throw new BarrierRefusal("sql-schema-readiness-required");
    const recordSchemas = async (value: SqlSchemaReceipt) => {
      receipt.sqlSchemas = structuredClone(value);
      await record();
    };
    const schemas = await options.sqlSchemas(recordSchemas);
    await recordSchemas(schemas);
    const candidateHome = manifest.containers?.find(
      (container) => container.id === "PoolContainer",
    );
    if (candidateHome && schemas.homeImageDigest !== candidateHome.imageDigest) {
      const observed = /^sha256:[a-f0-9]{64}$/.test(schemas.homeImageDigest)
        ? schemas.homeImageDigest
        : "invalid";
      throw new BarrierRefusal(
        "home-schema-candidate-image-mismatch",
        `home required-image=${candidateHome.imageDigest} observed-image=${observed}`,
      );
    }
    assertSqlSchemas(schemas, manifest.candidate);
    unchanged();
    receipt.phase = "baseline";
    await record();
    for (const worker of manifest.workers) {
      const current = await options.provider.baseline(worker);
      if (canonical(current) !== canonical(worker.baseline))
        throw new BarrierRefusal("deployment-drift", worker.id);
    }
    for (const container of manifest.containers ?? []) {
      await options.containers!.verifySource(container);
      const baseline = await options.containers!.read(container);
      if (!sameContainerState(baseline, container.baseline))
        throw containerDrift(
          "container-baseline-drift",
          container.baseline,
          { ...containerSnapshot(baseline), activeRolloutId: baseline.activeRolloutId },
          container.id,
        );
    }
    receipt.phase = "activation";
    for (const accepted of receipt.accepted) {
      unchanged();
      const worker = manifest.workers.find((item) => item.id === accepted.worker)!;
      // Persist intent first. A lost response must remain an uncertain activation, never a blind retry.
      receipt.pending = { worker: worker.id, versionId: accepted.versionId };
      await record();
      await options.provider.activate(worker, accepted.versionId);
      receipt.activated.push(receipt.pending);
      delete receipt.pending;
      await record();
    }
    for (const container of manifest.containers ?? []) {
      unchanged();
      receipt.phase = "container-activation";
      // Worker activation can take time. Recheck the application immediately before its only write.
      await options.containers!.verifySource(container);
      const baseline = await options.containers!.read(container);
      if (!sameContainerState(baseline, container.baseline))
        throw containerDrift(
          "container-baseline-drift",
          container.baseline,
          { ...containerSnapshot(baseline), activeRolloutId: baseline.activeRolloutId },
          container.id,
        );
      if (equalContainerConfiguration(container.baseline.configuration, container.configuration)) {
        receipt.containers!.push({
          container: container.id,
          version: container.baseline.version,
          unchanged: true,
        });
        receipt.pendingContainer = {
          container: container.id,
          phase: "verification",
          version: container.baseline.version,
        };
        await record();
        const unchanged = await options.containers!.read(container);
        if (!sameContainerState(unchanged, container.baseline))
          throw containerDrift(
            "container-baseline-drift",
            container.baseline,
            { ...containerSnapshot(unchanged), activeRolloutId: unchanged.activeRolloutId },
            container.id,
          );
        await options.containers!.verify(container, unchanged);
        delete receipt.pendingContainer;
        await record();
        continue;
      }
      receipt.pendingContainer = { container: container.id, phase: "rollout" };
      await record();
      const rollout = await options.containers!.rollout(container);
      if (
        !rollout.id ||
        rollout.currentVersion !== container.baseline.version ||
        !Number.isSafeInteger(rollout.targetVersion) ||
        rollout.targetVersion <= rollout.currentVersion
      )
        throw new BarrierRefusal("container-rollout-unconfirmed", container.id);
      const activation = {
        container: container.id,
        version: rollout.targetVersion,
        rolloutId: rollout.id,
        promoted: false,
      };
      receipt.containers!.push(activation);
      receipt.pendingContainer = {
        container: container.id,
        phase: "advance",
        version: rollout.targetVersion,
        rolloutId: rollout.id,
      };
      await record();
      await options.containers!.advance(container, rollout);
      activation.promoted = true;
      receipt.pendingContainer.phase = "verification";
      await record();
      const observed = await options.containers!.wait(container, rollout);
      assertConfiguredContainer(observed, container);
      if (observed.version !== rollout.targetVersion || observed.activeRolloutId)
        throw containerDrift(
          "container-version-drift",
          { version: rollout.targetVersion, activeRolloutId: undefined },
          { version: observed.version, activeRolloutId: observed.activeRolloutId },
          container.id,
        );
      await options.containers!.verify(container, observed);
      delete receipt.pendingContainer;
      await record();
    }
    receipt.phase = "complete";
    await record();
    return receipt;
  } catch (error) {
    receipt.failure =
      error instanceof BarrierRefusal
        ? {
            reason: error.reason,
            ...(error.worker ? { worker: error.worker } : {}),
            ...(error.delta ? { delta: error.delta } : {}),
            ...(error instanceof ReleaseOperationFailure
              ? { operation: error.operation, provider: error.provider }
              : {}),
          }
        : {
            reason:
              receipt.phase === "activation" || receipt.phase === "container-activation"
                ? "activation-unconfirmed"
                : "barrier-operation-failed",
          };
    await record();
    throw error instanceof BarrierRefusal
      ? error
      : new BarrierRefusal(
          receipt.failure.reason,
          receipt.pending?.worker ?? receipt.pendingContainer?.container,
        );
  }
}
