import { Cause, Context, Effect, Exit } from "effect";
import type { StateService } from "alchemy/State/State";
import { State } from "alchemy/State/State";
import type { CompiledStack } from "alchemy/Stack";
import { poolWorkerRevision } from "../../.upstream/apps/hosted/server/src/implementation/pool-worker-revision.ts";
import type { ControllerCode } from "../../src/pool/runtime-slots/contract.ts";
import { desiredPoolImageInput } from "../../src/pool/image-release-plan.ts";
import { assertPoolImageTarget } from "../deploy-safety/pool-image.ts";
import { deployEnvironment } from "../environment.ts";
import { checkReleaseHeadroom } from "../release-phases/headroom.ts";
import {
  baselineControllerHealth,
  readBaselineController,
  readBaselineControllerKey,
  type BaselineController,
} from "./baseline-controller.ts";
import { verifyContainerHealth } from "./container-health.ts";
import { legacyAdoptionTarget } from "./legacy-adoption-target.ts";
import { canonical } from "./manifest.ts";
import { assertMigrationActivationSettled } from "./migration-activation-state.ts";
import { BarrierRefusal } from "./refusal.ts";
import { NotApplicable, type preflightRunner } from "./release-preflight.ts";
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
import { runtimeReleaseJournal } from "./runtime-release-journal.ts";
import { verifyBoundProviderObservation } from "./runtime-provider-observation.ts";
import { releaseSelectedReady } from "./runtime-release-readiness.ts";
import { runtimeReleaseState, type RuntimeReleaseState } from "./runtime-release-state.ts";
import { readRuntimeProviderProof } from "./runtime-slot-provider-proof.ts";

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
      await step(
        "release-journal",
        ["state-version"],
        async () => {
          const record = await (
            await read(runtimeReleaseJournal(compiled, writer, encryptionKey))
          ).read();
          // The release's own first verdict on its journal.
          if (record?.abort)
            throw new BarrierRefusal("runtime-release-candidate-aborted-or-pending", "PoolWorker");
          return record;
        },
        (record) =>
          record
            ? { record: "this-candidate", complete: record.complete, aborted: !!record.abort }
            : { record: "none-or-settled" },
      );
      const baseline = await step(
        "baseline-controller",
        ["state-version"],
        async () => ({
          controller: await read(readBaselineController(compiled)),
          key: await read(readBaselineControllerKey(compiled)),
        }),
        (value) => ({ recordedCandidate: value.controller.code.candidate }),
      );
      const native = await step("runtime-state", ["state-version"], () =>
        read(runtimeReleaseState(compiled)),
      );
      if (native && baseline) await controllerReads(native, baseline);
      else
        for (const name of controllerSteps)
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
      baseline: { controller: BaselineController; key: string },
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
            const client = await clientFor(code);
            return { source, code, client, snapshot: await client.inspect() };
          };
          let recordedFailure: unknown;
          try {
            return await attempt("recorded", baseline.controller.code);
          } catch (error) {
            recordedFailure = error;
          }
          const release = await runningRelease(target);
          const running = release && { candidate: release, workerInput: poolWorkerRevision };
          // Only a different code is worth a second read; otherwise the recorded refusal stands.
          if (!running || canonical(running) === canonical(baseline.controller.code))
            throw recordedFailure;
          return attempt("running", running);
        },
        (value) => ({
          source: value.source,
          candidate: value.code.candidate,
          selected: !!value.snapshot.selection,
          dirtyPolicies: value.snapshot.policies.filter((row) => row.dirty).length,
        }),
      );
      if (!controller) {
        for (const name of controllerSteps.slice(1))
          await step(name, ["live-controller"], async () => {});
        return;
      }
      const { client, code, snapshot } = controller;
      const selection = snapshot.selection;

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
      await step("final-readiness", ["live-controller"], async () => {
        if (!selection) throw new NotApplicable("no selection; finalize runs after promotion");
        return releaseSelectedReady(live, code, client, selection.active.target.imageInput);
      });
    }
  });
