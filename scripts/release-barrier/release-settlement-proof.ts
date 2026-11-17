import { State, type StateService } from "alchemy/State/State";
import type { CompiledStack } from "alchemy/Stack";
import { Config, Effect, Redacted, Schema } from "effect";
import { readVersionPlacement } from "./active-placement-read.ts";
import {
  baselineControllerHealth,
  readBaselineController,
  readBaselineControllerKey,
  type BaselineRead,
} from "./baseline-controller.ts";
import { observeContainer } from "./container-cloudflare.ts";
import { containerSnapshot, imageDigest, sameContainerState } from "./container.ts";
import { assertBaselinePlacement, controllerForwardHealth } from "./controller-forward-health.ts";
import { encodedRecordHash, readForwardPacket } from "./forward-model.ts";
import { journalKey } from "./forward-journal.ts";
import { resumeForwardRelease } from "./forward-resume.ts";
import { BarrierRefusal, canonical, digest } from "./manifest.ts";
import { openRecovery } from "./recovery-envelope.ts";
import { decodeRuntimeReleaseHead } from "./runtime-release-journal.ts";
import { runtimeReleaseState } from "./runtime-release-state.ts";
import { normalizePlacement } from "./script-placement.ts";
import {
  ReleaseSettlementProof,
  releaseImageJournalKey,
  type ReleaseSettlementDisposition,
} from "./release-settlement-contract.ts";
import {
  readAdoptedController,
  readUnadoptedController,
} from "./release-settlement-controller-reads.ts";
import { readActivatedLive } from "./release-settlement-live.ts";
import type { ControllerCode } from "../../src/pool/runtime-slots/contract.ts";
import { settlementSourceFailure } from "./release-settlement-source.ts";
import type { PoolOperationsTarget } from "../pool-operations.ts";
import { readServingObservation } from "./serving-observation.ts";

const hash = (value: unknown) => digest(canonical(value));
const forwardHeader = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  candidate: Schema.String,
  manifest: Schema.String,
  complete: Schema.Boolean,
  sealed: Schema.Unknown,
});
// The earlier disposition keeps its message; the later one names the guard that failed.
const notSettleable = (disposition: ReleaseSettlementDisposition, guard?: string) =>
  disposition === "abandoned-before-controller"
    ? new BarrierRefusal("release-settlement-not-pre-controller", "PoolWorker")
    : new BarrierRefusal("release-settlement-not-controller-active", guard ?? "PoolWorker");
export type ReleaseSettlementIo = {
  forward?: NonNullable<Parameters<typeof resumeForwardRelease>[1]["io"]>;
  container?: typeof observeContainer;
  placement?: typeof readVersionPlacement;
  connect?: PoolOperationsTarget["connect"];
  runtimeRead?(call: BaselineRead): Promise<void>;
};

export const collectReleaseSettlementProof = (
  stack: CompiledStack,
  sourceCandidate: string,
  key: string,
  directory: string,
  io: ReleaseSettlementIo,
  disposition: ReleaseSettlementDisposition,
  sourceController?: typeof ControllerCode.Type,
) =>
  Effect.gen(function* () {
    const refuse = () => notSettleable(disposition);
    const activated = disposition !== "abandoned-before-controller";
    const state = yield* yield* State;
    const image = yield* state.getOutput(releaseImageJournalKey(stack));
    const forward = yield* state.getOutput(journalKey(stack));
    const { record } = decodeRuntimeReleaseHead(image, key);
    const head = Schema.decodeUnknownSync(forwardHeader)(forward);
    // A finished controller phase completes its forward head; an abandoned upload never does.
    if (head.complete !== activated) throw notSettleable(disposition, "forward.complete");
    const packet = readForwardPacket(openRecovery(head.sealed, key, head.candidate, head.manifest));
    const unsettled = settlementSourceFailure(disposition, sourceCandidate, record, head, packet);
    if (unsettled) throw notSettleable(disposition, unsettled);
    const resources = [
      ...new Set([
        ...packet.manifest.workers.map((worker) => worker.id),
        ...Object.values(record.baseline.applications).flatMap((application) =>
          application ? [application.resource] : [],
        ),
        "PoolBackendBudgetRuntimeReady",
      ]),
    ].sort();
    const nativeResources: { fqn: string; digest: string }[] = [];
    for (const fqn of resources) {
      const row = yield* state.get({ stack: stack.name, stage: stack.stage, fqn });
      if (!row) throw refuse();
      nativeResources.push({ fqn, digest: encodedRecordHash(row) });
    }
    if (
      activated !== (sourceController !== undefined) ||
      (sourceController && sourceController.candidate !== sourceCandidate)
    )
      throw new BarrierRefusal("release-settlement-source-controller-unproven", "PoolWorker");
    const recorded = yield* readBaselineController(stack);
    // Scale-out code phases defer the readiness command, so its record still names the controller
    // that ran before the source. The signed reads below prove the source code live instead.
    // An abandoned source never activated its own controller, so the live one is the controller its
    // image record froze; after an earlier settlement the deferred readiness row can be older still.
    const baseline = {
      ...recorded,
      code: sourceController ?? record.baselineController?.code ?? recorded.code,
    };
    const signingKey = yield* readBaselineControllerKey(stack);
    const native = yield* runtimeReleaseState(stack);
    if (
      hash(JSON.parse(JSON.stringify(native))) !== hash(record.baseline) ||
      baseline.target.accountId !== record.baseline.target.accountId ||
      baseline.target.worker !== record.baseline.target.worker ||
      signingKey !== record.baseline.deploymentKey
    )
      throw new BarrierRefusal("release-settlement-image-baseline-drift", "PoolWorker");
    const target = { ...baseline.target, connect: io.connect };
    const deny = () => Effect.die(new BarrierRefusal("release-settlement-state-write-refused"));
    const readOnly: StateService = {
      ...state,
      set: deny,
      delete: deny,
      deleteStack: deny,
      setOutput: deny,
    };
    const baselineHealth = (
      container: Parameters<typeof controllerForwardHealth>[0]["container"],
      observation: Parameters<typeof controllerForwardHealth>[0]["observation"],
    ) =>
      controllerForwardHealth({
        baseline,
        container,
        observation,
        baselineHealth: () =>
          baselineControllerHealth({
            baseline,
            key: signingKey,
            target,
            record: io.runtimeRead,
          }),
        candidateReady: async () => {
          throw refuse();
        },
        candidateHealth: async () => {
          throw refuse();
        },
      });
    const reconcileAbandoned = () =>
      Effect.gen(function* () {
        const report = yield* resumeForwardRelease(stack, {
          dryRun: true,
          directory,
          io: { ...io.forward, ...(io.container ? { container: io.container } : {}) },
          runtime: (container, _observed, observation) => baselineHealth(container, observation),
        });
        if (
          !report ||
          report.disposition !== "baseline" ||
          report.before !== report.after ||
          report.continuation
        )
          throw refuse();
        const { instanceId, bootId, workers } = report;
        return { evidence: report, native: report.before, instanceId, bootId, workers };
      });
    // Adopt committed a selection, so the recovery read refuses; the signed reads prove the root.
    const adoptedHealth = (
      container: Parameters<typeof controllerForwardHealth>[0]["container"],
      observation: Parameters<typeof controllerForwardHealth>[0]["observation"],
    ) => {
      assertBaselinePlacement(baseline, container, observation);
      return readAdoptedController({
        controller: baseline,
        key: signingKey,
        sourceCandidate,
        root: record.baseline.applications.root,
        instances: observation.instances.map((instance) => instance.id),
        target,
        record: io.runtimeRead,
      });
    };
    // A finished controller phase completed its forward head, so there is nothing to reconcile.
    const readOnlyState = Effect.provideService(State, Effect.succeed(readOnly));
    const adopted =
      disposition === "controller-active-adopted"
        ? yield* readActivatedLive(stack, packet, io, adoptedHealth).pipe(readOnlyState)
        : undefined;
    const live =
      adopted ??
      (activated
        ? yield* readActivatedLive(stack, packet, io, baselineHealth).pipe(readOnlyState)
        : yield* reconcileAbandoned().pipe(readOnlyState));
    const workers: (typeof ReleaseSettlementProof.Type)["workers"][number][] = [];
    for (const worker of packet.manifest.workers) {
      const active = live.workers.find((row) => row.worker === worker.id)?.versions;
      const accepted = packet.receipt.accepted.find((row) => row.worker === worker.id)?.versionId;
      if (activated) {
        if (canonical(active) !== canonical([{ versionId: accepted, percentage: 100 }]))
          throw new BarrierRefusal("release-settlement-worker-not-accepted", worker.id);
      } else if (canonical(active) !== canonical(worker.baseline))
        throw new BarrierRefusal("release-settlement-worker-not-baseline", worker.id);
      const versionIds = [
        ...new Set([
          ...worker.baseline.map((row) => row.versionId),
          ...(accepted ? [accepted] : []),
        ]),
      ].sort();
      if (versionIds.length > 4)
        throw new BarrierRefusal("release-settlement-version-read-limit", worker.id);
      const row = yield* state.get({ stack: stack.name, stage: stack.stage, fqn: worker.id });
      if (
        !row ||
        (row.status !== "created" && row.status !== "updated") ||
        row.resourceType !== "Cloudflare.Worker"
      )
        throw refuse();
      const target = Schema.decodeUnknownSync(
        Schema.Struct({ accountId: Schema.String, workerName: Schema.String }),
      )(row.attr);
      const placements = [];
      for (const versionId of versionIds) {
        const value = yield* (io.placement ?? readVersionPlacement)(
          target.accountId,
          target.workerName,
          versionId,
        );
        placements.push({
          versionId,
          digest: hash({
            placement: normalizePlacement(value.placement, [value], [{ versionId }]),
            limits: value.limits ?? null,
            bindings: value.bindings ?? [],
          }),
        });
      }
      workers.push({
        worker: worker.id,
        target: worker.target,
        baseline: worker.baseline,
        active: active!,
        accepted: accepted ?? null,
        placements,
      });
    }
    const applications = [];
    for (const application of Object.values(record.baseline.applications)) {
      if (!application) continue;
      const observed = yield* (io.container ?? observeContainer)(application.attributes);
      if (
        observed.activeRolloutId ||
        !sameContainerState(observed, containerSnapshot(application.attributes))
      )
        throw new BarrierRefusal("release-settlement-application-drift", application.resource);
      let inactivePlacements;
      if (application.resource !== "PoolContainer") {
        const token = yield* Config.Redacted("CLOUDFLARE_API_TOKEN");
        inactivePlacements = yield* Effect.promise(() =>
          (io.forward?.observation ?? readServingObservation)(
            {
              ...application.attributes,
              digest: imageDigest(application.attributes.configuration.image),
            },
            Redacted.value(token),
            AbortSignal.timeout(15_000),
          ),
        );
        if (
          inactivePlacements.version !== application.attributes.version ||
          inactivePlacements.digest !== application.image.digest ||
          inactivePlacements.activeRolloutId ||
          inactivePlacements.instances.length
        )
          throw new BarrierRefusal(
            "release-settlement-inactive-application-serving",
            application.resource,
          );
      }
      applications.push({
        resource: application.resource,
        digest: hash({
          application: containerSnapshot(observed),
          inactivePlacements: inactivePlacements ?? null,
        }),
      });
    }
    const controllerReads =
      disposition === "controller-active-unadopted"
        ? yield* Effect.promise(() =>
            readUnadoptedController({
              controller: baseline,
              key: signingKey,
              root: record.baseline.applications.root,
              instanceId: live.instanceId,
              target,
              record: io.runtimeRead,
            }),
          )
        : adopted?.health.reads;
    for (const resource of nativeResources) {
      const row = yield* state.get({ stack: stack.name, stage: stack.stage, fqn: resource.fqn });
      if (encodedRecordHash(row) !== resource.digest)
        throw new BarrierRefusal("release-settlement-native-drift", resource.fqn);
    }
    if (
      hash(yield* state.getOutput(releaseImageJournalKey(stack))) !== hash(image) ||
      hash(yield* state.getOutput(journalKey(stack))) !== hash(forward)
    )
      throw new BarrierRefusal("release-settlement-head-drift", "PoolWorker");
    const proof = Schema.decodeUnknownSync(ReleaseSettlementProof)({
      disposition,
      ...(controllerReads ? { controllerReads } : {}),
      controller: baseline,
      health: { instanceId: live.instanceId, bootId: live.bootId },
      imageBaselineDigest: hash(record.baseline),
      nativeBeforeDigest: live.native,
      nativeAfterDigest: live.native,
      nativeResources,
      workers,
      applications,
      forwardManifest: packet.receipt.manifest,
      forwardProofDigest: hash(live.evidence),
      stateWrites: 0,
      runtimeMutations: 0,
    });
    return { proof, source: { image, forward } };
  }).pipe(Effect.timeout("5 minutes"));
