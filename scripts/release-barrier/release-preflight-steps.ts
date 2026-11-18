import { Cause, Context, Effect, Exit } from "effect";
import type { StateService } from "alchemy/State/State";
import { State } from "alchemy/State/State";
import type { CompiledStack } from "alchemy/Stack";
import { poolWorkerRevision } from "../../.upstream/apps/hosted/server/src/implementation/pool-worker-revision.ts";
import type { ControllerCode, SlotTarget } from "../../src/pool/runtime-slots/contract.ts";
import { desiredPoolImageInput } from "../../src/pool/image-release-plan.ts";
import { assertPoolImageTarget } from "../deploy-safety/pool-image.ts";
import { deployEnvironment } from "../environment.ts";
import { checkReleaseHeadroom } from "../release-phases/headroom.ts";
import {
  baselineControllerHealth,
  readBaselineController,
  readBaselineControllerKey,
  releaseBaselineController,
  type BaselineController,
  type BaselineControllerSource,
} from "./baseline-controller.ts";
import { verifyContainerHealth } from "./container-health.ts";
import { isLegacyAdoptionTarget, legacyAdoptionTarget } from "./legacy-adoption-target.ts";
import { assertMigrationActivationSettled } from "./migration-activation-state.ts";
import { BarrierRefusal } from "./refusal.ts";
import {
  NotApplicable,
  SettlementRequired,
  preflightRefusal,
  type PreflightRefusal,
  type preflightRunner,
} from "./release-preflight.ts";

/** Commit and worker-input hashes only; both are public build identities. */
export type ControllerAttempt = {
  source: string;
  candidate: string;
  workerInput: string;
  route: string;
  outcome: "accepted" | PreflightRefusal;
};
import { liveControllerCodes, settlementVerdict } from "./release-preflight-live.ts";
import { releaseImageJournalKey } from "./release-settlement-contract.ts";
import {
  nodeBridgeFromConfig,
  readOnlyPoolOperations,
  readOnlyReleaseWriter,
  runningRelease,
  type PreflightBridgeCounters,
} from "./release-preflight-guard.ts";
import { assertReleaseStateVersion } from "./release-state-version.ts";
import { runtimeReleaseClient } from "./runtime-release-client.ts";
import { assertReleaseImageCapacity } from "./runtime-release-image.ts";
import { decodeRuntimeReleaseHead, runtimeReleaseJournal } from "./runtime-release-journal.ts";
import { verifyBoundProviderObservation } from "./runtime-provider-observation.ts";
import { releaseSelectedReady } from "./runtime-release-readiness.ts";
import { runtimeReleaseState, type RuntimeReleaseState } from "./runtime-release-state.ts";
import { readRuntimeProviderProof } from "./runtime-slot-provider-proof.ts";

/**
 * The release promotes a fleet primary before finalize, so it never reads readiness from the legacy
 * root, whether adopt's unattested grant or a recovery restart is its witness.
 */
export async function finalReadiness<T>(
  selection: { active: { target: SlotTarget } } | undefined,
  ready: () => Promise<T>,
) {
  if (!selection) throw new NotApplicable("no selection; finalize runs after promotion");
  if (isLegacyAdoptionTarget(selection.active.target))
    throw new NotApplicable("post-promote-only: the active slot is the legacy root");
  return ready();
}

// Steps that need the live controller, in release order; listed so a missing input still reports each.
const controllerSteps = [
  "live-controller",
  "selection-proof",
  "active-health",
  "baseline-health",
  "provider-observe",
  "adoption-reads",
  "fleet-inspect",
  "witness",
  "image-capacity",
  "final-readiness",
];

/**
 * The release's production reads in release order, each through the release's own function.
 * Not reachable read-only: backup, code adoption, candidate-code reads before its controller
 * phase, the stack plan and forward resume (baseline-probe job), the settlement proof (rehearsal
 * step), and every adopt, bind, promote, fleet, image, upload, version or deploy write.
 */
export const preflightSteps = (
  compiled: CompiledStack,
  input: {
    candidate: string;
    state: StateService;
    fetch: typeof globalThis.fetch;
    bridge: PreflightBridgeCounters;
    runner: ReturnType<typeof preflightRunner>;
    credentials: { accountId: string; apiToken: string; encryptionKey: string };
    directory: string;
    /** Controller codes named by earlier release receipts; see liveControllerCodes. */
    receipts: readonly (typeof ControllerCode.Type)[];
    /** Each live-controller inspect: the code it signed with and how the controller answered. */
    attempts: ControllerAttempt[];
  },
) =>
  Effect.gen(function* () {
    const { candidate, state, bridge, runner, directory } = input;
    const { accountId, apiToken, encryptionKey } = input.credentials;
    const { step } = runner;
    const writer = readOnlyReleaseWriter(candidate);
    const services = Context.add(compiled.services, State, Effect.succeed(state));
    const context = yield* Effect.context<never>();
    // Release readers are Effects over the compiled stack; each runs to an Exit so one refusal
    // becomes that step's result instead of ending the run.
    const read = async <A, E, R>(effect: Effect.Effect<A, E, R>) => {
      const exit = await Effect.runPromiseExitWith(context)(
        effect.pipe(Effect.provideContext(services)) as Effect.Effect<A, E, never>,
      );
      if (Exit.isFailure(exit)) throw Cause.squash(exit.cause);
      return exit.value;
    };

    yield* Effect.promise(async () => {
      await step("database-headroom", [], () => checkReleaseHeadroom(deployEnvironment()));
      await step("state-version", [], () =>
        read(assertReleaseStateVersion(compiled, input.fetch, "release")),
      );
      await step("migration-activation", ["state-version"], () =>
        read(assertMigrationActivationSettled(state, compiled, encryptionKey)),
      );
      const journal = await step(
        "release-journal",
        ["state-version"],
        async () => {
          try {
            // The release's own first verdict on its journal: the head its init reads.
            const head = await (
              await read(runtimeReleaseJournal(compiled, writer, encryptionKey))
            ).head();
            if (head.record?.abort)
              throw new BarrierRefusal(
                "runtime-release-candidate-aborted-or-pending",
                "PoolWorker",
              );
            return { head, prior: undefined };
          } catch (error) {
            if (
              !(error instanceof BarrierRefusal) ||
              error.reason !== "runtime-release-prior-candidate-unsettled"
            )
              throw error;
            // Which settlement it needs depends on the live controller; release-settlement decides.
            const head = await read(state.getOutput(releaseImageJournalKey(compiled)));
            return {
              head: { record: undefined, sourceController: undefined },
              prior: decodeRuntimeReleaseHead(head, encryptionKey).record.candidate,
            };
          }
        },
        ({ head: { record, sourceController }, prior }) =>
          prior
            ? { record: "prior-candidate-unsettled", prior }
            : record
              ? { record: "this-candidate", complete: record.complete }
              : sourceController
                ? { record: "prior-settled-or-aborted", sourceCandidate: sourceController.candidate }
                : { record: "none" },
      );
      // After a controller-active settlement the readiness row names an older controller than the
      // live one; the release's own choice for this journal head names the live one.
      const baseline = await step(
        "baseline-controller",
        ["state-version", "release-journal"],
        async () => {
          const chosen = await read(releaseBaselineController(compiled, journal!.head));
          // A resumed release's frozen code may be older than the one its own code phase recorded,
          // so the readiness code stays a fallback; unreadable, it is simply not offered.
          const recorded =
            chosen.source === "recorded"
              ? chosen.controller.code
              : await read(readBaselineController(compiled)).then(
                  (value) => value.code,
                  () => undefined,
                );
          return { ...chosen, recorded, key: await read(readBaselineControllerKey(compiled)) };
        },
        (value) => ({ candidate: value.controller.code.candidate, source: value.source }),
      );
      const native = await step("runtime-state", ["state-version"], () =>
        read(runtimeReleaseState(compiled)),
      );
      if (native && baseline) await controllerReads(native, baseline, journal?.prior);
      else
        for (const name of [...controllerSteps, ...(journal?.prior ? ["release-settlement"] : [])])
          await step(name, ["baseline-controller", "runtime-state"], async () => {});
      // The image verifier reads only the native State rows, so it runs even without a controller.
      await step(
        "post-deploy-image",
        ["runtime-state"],
        async () => {
          if (!native)
            throw new BarrierRefusal("release-preflight-state-unavailable", "PoolWorker");
          const root = native.applications.root.image;
          return assertPoolImageTarget(
            // The retained native image carries no account, so bind the baseline target's account.
            { ...root, accountId: native.target.accountId },
            { workerName: native.target.worker, inputHash: root.inputHash },
            { accountId, apiToken },
            input.fetch,
          );
        },
        (observed) => ({ instances: observed.instances.length, path: observed.verifiedPath }),
      );
    });

    async function controllerReads(
      native: RuntimeReleaseState,
      baseline: {
        controller: BaselineController;
        source: BaselineControllerSource;
        recorded: typeof ControllerCode.Type | undefined;
        key: string;
      },
      prior: string | undefined,
    ) {
      const target = {
        ...native.target,
        connect: readOnlyPoolOperations(nodeBridgeFromConfig, native.deploymentKey, bridge),
      };
      const live: RuntimeReleaseState = { ...native, target };
      const clientFor = (code: typeof ControllerCode.Type) =>
        read(
          runtimeReleaseClient({
            state: live,
            code,
            writer,
            target,
            promotion: {
              read: async () => undefined,
              write: async () => {
                throw new BarrierRefusal("release-preflight-mutation-refused", "promotion.write");
              },
            },
          }),
        );
      const rootHealth = () =>
        verifyContainerHealth(
          target,
          native.applications.root.image.inputHash,
          AbortSignal.timeout(15_000),
        );

      // The candidate's controller is not live yet, so its reads use the code that is. A scale-out
      // code phase defers the readiness record, so the recorded code may lag the running one.
      const controller = await step(
        "live-controller",
        [],
        async () => {
          const attempt = async (source: string, code: typeof ControllerCode.Type) => {
            const record: ControllerAttempt = {
              source,
              ...code,
              route: "PoolOperations POST /runtime-handoff inspect",
              outcome: "accepted",
            };
            input.attempts.push(record);
            try {
              const client = await clientFor(code);
              return { source, code, client, snapshot: await client.inspect() };
            } catch (error) {
              record.outcome = preflightRefusal(error);
              throw error;
            }
          };
          // The release's own choice goes first; it is the readiness code when its source is.
          const chosen = { source: baseline.source, code: baseline.controller.code };
          const release = chosen.source === "recorded" ? undefined : chosen;
          let first: unknown;
          try {
            return await attempt(chosen.source, chosen.code);
          } catch (error) {
            first = error;
          }
          // The controller refuses any code but its own, so an accepted inspect proves the code.
          const options = liveControllerCodes({
            ...(release ? { release } : {}),
            recorded: baseline.recorded,
            ...(prior ? { prior } : {}),
            running: await runningRelease(target),
            receipts: input.receipts,
            workerInput: poolWorkerRevision,
          }).slice(1);
          for (const option of options)
            try {
              return await attempt(option.source, option.code);
            } catch {}
          throw first;
        },
        (value) => ({
          source: value.source,
          candidate: value.code.candidate,
          selected: !!value.snapshot.selection,
          dirtyPolicies: value.snapshot.policies.filter((row) => row.dirty).length,
        }),
      );
      if (!controller) {
        for (const name of [...controllerSteps.slice(1), ...(prior ? ["release-settlement"] : [])])
          await step(name, ["live-controller"], async () => {});
        return;
      }
      const { client, code, snapshot } = controller;
      const selection = snapshot.selection;

      if (prior)
        await step("release-settlement", ["live-controller"], async () => {
          const verdict = settlementVerdict({
            prior,
            liveCandidate: code.candidate,
            selected: !!selection,
          });
          if (!verdict.supported)
            throw new BarrierRefusal(
              "release-preflight-settlement-unsupported",
              verdict.disposition,
            );
          throw new SettlementRequired(verdict.disposition);
        });

      await step(
        "selection-proof",
        ["live-controller"],
        async () =>
          selection
            ? client.manifest(selection.active.target, `preflight-${candidate}`)
            : client.manifest(
                legacyAdoptionTarget(native.applications.root, (await rootHealth()).instanceId),
                `preflight-${candidate}`,
                "preserve-unattested",
              ),
        (manifest) => ({
          expectedEpoch: manifest.selection.expectedEpoch,
          revisions: manifest.selection.revisions.length,
        }),
      );
      await step("active-health", ["live-controller"], async () => {
        if (!selection) throw new NotApplicable("no selection; the release adopts first");
        return client.health();
      });
      await step("baseline-health", ["live-controller"], async () => {
        if (selection)
          throw new NotApplicable("a selection exists; the release uses active-health");
        return baselineControllerHealth({
          baseline: baseline.controller,
          key: baseline.key,
          target,
        });
      });
      await step("provider-observe", ["live-controller"], () =>
        verifyBoundProviderObservation({ state: live, code, client, directory, encryptionKey }),
      );
      await step("adoption-reads", ["live-controller"], async () => {
        if (selection) throw new NotApplicable("already adopted; the release only reads health");
        const retained = await client.manifest(
          legacyAdoptionTarget(native.applications.root, (await rootHealth()).instanceId),
          `adopt-${candidate}`,
          "preserve-unattested",
        );
        // The release signs and sends the adopt next; both are writes this preflight refuses.
        await read(readRuntimeProviderProof(retained, "runtime"));
      });
      await step(
        "fleet-inspect",
        ["live-controller"],
        () => client.fleet(),
        (value) => ({
          permission: !!value.permission,
          resources: value.resources.length,
          bindings: value.bindings.length,
        }),
      );
      await step(
        "witness",
        ["live-controller"],
        async () => {
          if (!selection) throw new NotApplicable("no selection to witness");
          return client.selectedCurrent(selection.active.target.imageInput, native.configuration);
        },
        (current) => ({ liveConfigurationWitnessed: current }),
      );
      await step("image-capacity", ["fleet-inspect"], async () => {
        // The release checks capacity only on its way to a new inactive image.
        if (selection?.candidate) throw new NotApplicable("a candidate is already pending");
        const desired = await read(desiredPoolImageInput);
        if (selection && desired === selection.active.target.imageInput)
          throw new NotApplicable("image input unchanged; the release keeps the live image");
        return assertReleaseImageCapacity(client);
      });
      await step("final-readiness", ["live-controller"], () =>
        finalReadiness(selection, () =>
          releaseSelectedReady(live, code, client, selection!.active.target.imageInput),
        ),
      );
    }
  });
