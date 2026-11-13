import { evalStack, type CompiledStack, type StackEffect } from "alchemy/Stack";
import type { Stage } from "alchemy/Stage";
import type { AlchemyContext } from "alchemy/AlchemyContext";
import { State } from "alchemy/State/State";
import { Context, Effect } from "effect";
import { copyFile } from "node:fs/promises";
import { resolve } from "node:path";
import { poolWorkerRevision } from "../../.upstream/apps/hosted/server/src/implementation/pool-worker-revision.ts";
import {
  RuntimeImageReleasePlan,
  type ImageReleasePlan,
} from "../../src/pool/image-release-plan.ts";
import { provisioningStack } from "./provisioning-stack.ts";
import { assertReleaseStateVersion } from "./release-state-version.ts";
import { deployStack, type DeployStackOptions } from "./deploy-stack.ts";
import { resumeForwardRelease } from "./forward-resume.ts";
import { runtimeReleaseState } from "./runtime-release-state.ts";
import { runtimeReleaseDesired } from "./runtime-release-desired.ts";
import { runtimeReleaseJournal, type RuntimeReleaseRecord } from "./runtime-release-journal.ts";
import { runtimeReleaseClient } from "./runtime-release-client.ts";
import type { RuntimeReleaseWriter } from "./runtime-release-writer.ts";
import { bootstrapReleaseApplication } from "./runtime-release-bootstrap.ts";
import { configureReleaseFleet } from "./runtime-release-fleet.ts";
import { runtimeReleaseImage } from "./runtime-release-image.ts";
import {
  releaseCodeReady,
  releaseSelectedReady,
  waitReleaseObservation,
} from "./runtime-release-readiness.ts";
import { verifyContainerHealth } from "./container-health.ts";
import { BarrierRefusal } from "./refusal.ts";

const provideCompiled = <A, E, R>(compiled: CompiledStack, effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    Effect.provideContext(compiled.services),
    Effect.provideService(State, Context.get(compiled.services, State)),
  );

/** The normal deploy entry owns code, inactive image, attested serving, promotion and final readiness. */
export const releaseRuntimeImage = <A, StackError>(
  stack: StackEffect<CompiledStack<A>, StackError, Stage | AlchemyContext>,
  options: DeployStackOptions & {
    directory: string;
    writer: RuntimeReleaseWriter;
    encryptionKey: string;
  },
) =>
  Effect.gen(function* () {
    const code = { candidate: options.candidate, workerInput: poolWorkerRevision };
    const evaluate = <A, E, R>(
      plan: ImageReleasePlan,
      use: (compiled: CompiledStack) => Effect.Effect<A, E, R>,
    ) =>
      evalStack(stack, (compiled) => provideCompiled(compiled, use(compiled)), {
        stage: "production",
      }).pipe(Effect.provideService(RuntimeImageReleasePlan, plan));
    const initial = yield* evaluate({ images: {} }, (compiled) =>
      Effect.gen(function* () {
        yield* assertReleaseStateVersion(compiled);
        const journal = yield* runtimeReleaseJournal(
          compiled,
          options.writer,
          options.encryptionKey,
        );
        let record = yield* Effect.promise(journal.read);
        if (!record) {
          yield* resumeForwardRelease(compiled, { directory: options.directory });
          const baseline = yield* runtimeReleaseState(compiled);
          const desired = yield* runtimeReleaseDesired(compiled);
          record = {
            format: "pool-image-release-v1",
            candidate: options.candidate,
            complete: false,
            baseline,
            desiredInput: desired.imageInput,
            desiredConfiguration: desired.configuration,
            bootstrap: {},
            configurations: {},
          };
          yield* Effect.promise(() => journal.write(record!));
        }
        return { journal, record };
      }),
    );
    let record: RuntimeReleaseRecord = initial.record;
    const save = async (next: RuntimeReleaseRecord) => {
      await initial.journal.write(next);
      record = next;
    };
    const plan = (): ImageReleasePlan => ({
      ...(record.baseline.applications.legacy
        ? {
            legacy: {
              image: record.baseline.applications.legacy.image.image,
              props: record.baseline.applications.legacy.props,
            },
          }
        : {}),
      images: Object.fromEntries(
        (["blue", "green"] as const).flatMap((color) => {
          const application = record.baseline.applications[color];
          return application ? [[color, application.image.image]] : [];
        }),
      ),
      ...(record.update
        ? {
            candidateConfiguration: {
              applicationId: record.update.baseline.applicationId,
              configuration: record.desiredConfiguration,
            },
          }
        : {}),
    });
    const clientFor = () =>
      runtimeReleaseClient({
        state: record.baseline,
        code,
        writer: options.writer,
        desiredConfiguration: record.desiredConfiguration,
        promotion: {
          read: async () => record.promotion,
          write: async (promotion) => save({ ...record, promotion }),
        },
      });
    const retainPhase = async (name: string) => {
      for (const file of [
        "manifest.json",
        "receipt.json",
        "container-recovery.sealed.json",
        "publication.json",
        "serving.json",
        "admission.json",
      ])
        await copyFile(
          resolve(options.directory, file),
          resolve(options.directory, `${name}-${file}`),
        ).catch((error: NodeJS.ErrnoException) => {
          if (error.code !== "ENOENT") throw error;
        });
    };
    const codePhase = (name: string) =>
      evaluate(plan(), (compiled) =>
        Effect.gen(function* () {
          const client = yield* clientFor();
          const forward = yield* resumeForwardRelease(compiled, {
            directory: options.directory,
            runtime: () => client.health(),
          });
          yield* deployStack(compiled, {
            ...options,
            forwardInput: forward?.continuation,
            preserveRuntimeInputs: true,
            runtimeImage: {
              deferVerification: true,
              prepare: async () => {
                throw new BarrierRefusal("runtime-release-active-image-mutation", "PoolContainer");
              },
              verify: async (container, observed) => {
                if (
                  container.imageDigest !== container.baseline.configuration.image.split("@")[1] ||
                  container.configuration.image !== container.baseline.configuration.image ||
                  observed.version !== container.baseline.version
                )
                  throw new BarrierRefusal(
                    "runtime-release-active-image-mutation",
                    "PoolContainer",
                  );
                await releaseCodeReady(record.baseline, code);
                if ((await client.inspect()).selection) await client.health();
                else
                  await verifyContainerHealth(
                    record.baseline.target,
                    record.baseline.applications.root.image.inputHash,
                    AbortSignal.timeout(15_000),
                  );
              },
            },
          });
          yield* Effect.promise(() => retainPhase(name));
          yield* Effect.promise(() => releaseCodeReady(record.baseline, code));
          const native = yield* runtimeReleaseState(compiled);
          yield* Effect.promise(() => save({ ...record, baseline: native }));
          return yield* clientFor();
        }),
      );
    let client = yield* codePhase("controller");
    yield* Effect.promise(() => client.adopt());

    for (const color of ["blue", "green"] as const) {
      if (record.baseline.applications[color]) continue;
      const createPlan = {
        ...plan(),
        images: { ...plan().images, [color]: record.baseline.applications.root.image.image },
      };
      yield* evalStack(
        provisioningStack,
        (compiled) =>
          provideCompiled(
            compiled,
            bootstrapReleaseApplication(compiled, {
              color,
              record,
              writer: options.writer,
              client,
              encryptionKey: options.encryptionKey,
              save,
            }),
          ),
        { stage: "production" },
      ).pipe(Effect.provideService(RuntimeImageReleasePlan, createPlan));
      const native = yield* evaluate(createPlan, (compiled) => runtimeReleaseState(compiled));
      yield* Effect.promise(() => save({ ...record, baseline: native }));
      client = yield* codePhase(`bind-${color}`);
    }
    yield* Effect.promise(() =>
      waitReleaseObservation(
        async () => ({ slots: await client.inspect(), fleet: await client.fleet() }),
        (value) =>
          !value.slots.selection?.draining &&
          (!value.slots.selection?.candidate ||
            value.slots.selection.candidate.target.slotId === `primary-${options.candidate}`) &&
          value.fleet.resources.every(
            (row) => row.target.imageInput === value.slots.selection?.active.target.imageInput,
          ),
        "PoolWorker.previous-generation",
      ),
    );
    yield* Effect.promise(() =>
      configureReleaseFleet(client, record, `configure-${options.candidate}`, save),
    );
    const current = yield* Effect.promise(() =>
      client.selectedCurrent(record.desiredInput, record.desiredConfiguration),
    );
    if (!current) {
      const fleet = yield* Effect.promise(() => client.fleet());
      const selected = yield* Effect.promise(() => client.inspect());
      const activeApplication = selected.selection!.active.target.applicationId;
      const inactive =
        record.update?.baseline.color ??
        (fleet.permission!.configuration.applications.find(
          (app) => app.applicationId === activeApplication,
        )?.color === "green"
          ? "blue"
          : "green");
      const resource = inactive === "blue" ? "PoolRuntimeBlue" : "PoolRuntimeGreen";
      if (selected.selection?.candidate) {
        if (
          selected.selection.candidate.target.applicationId !==
          record.baseline.applications[inactive]!.attributes.applicationId
        )
          throw new BarrierRefusal("runtime-release-other-candidate-pending", resource);
      } else {
        const phase = yield* runtimeReleaseImage({ resource, client, read: () => record, save });
        yield* evaluate(
          {
            ...plan(),
            build: inactive,
            candidateConfiguration: {
              applicationId: record.baseline.applications[inactive]!.attributes.applicationId,
              configuration: record.desiredConfiguration,
            },
          },
          (compiled) =>
            Effect.gen(function* () {
              const forward = yield* resumeForwardRelease(compiled, {
                directory: options.directory,
                runtime: () => client.health(),
              });
              yield* deployStack(compiled, {
                ...options,
                forwardInput: forward?.continuation,
                runtimeImage: phase,
                preserveRuntimeInputs: true,
              });
              yield* Effect.promise(() => retainPhase("inactive-image"));
              const native = yield* runtimeReleaseState(compiled);
              yield* Effect.promise(() => save({ ...record, baseline: native }));
            }),
        );
        client = yield* clientFor();
        yield* Effect.promise(() =>
          configureReleaseFleet(client, record, `image-configure-${options.candidate}`, save),
        );
        yield* Effect.promise(() =>
          waitReleaseObservation(
            async () => ({ slots: await client.inspect(), fleet: await client.fleet() }),
            (value) => {
              const selection = value.slots.selection;
              const primaries = [
                selection?.active,
                selection?.candidate,
                selection?.draining,
              ].filter(
                (slot) => slot && slot.target.instanceId !== slot.target.controllerId,
              ).length;
              const maximum = value.fleet.permission?.configuration.maximum;
              return maximum !== undefined && value.fleet.resources.length + primaries < maximum;
            },
            resource,
          ),
        );
      }
      const pool =
        record.baseline.monitorPool ??
        (yield* Effect.promise(() => client.inspect())).policies[0]?.pool;
      if (!pool) throw new BarrierRefusal("runtime-release-public-pool-unavailable", "PoolWorker");
      yield* Effect.promise(() =>
        client.promote(
          record.baseline.applications[inactive]!.attributes.applicationId,
          `primary-${options.candidate}`,
          pool,
        ),
      );
    }
    yield* Effect.promise(() =>
      waitReleaseObservation(
        async () => ({ slots: await client.inspect(), fleet: await client.fleet() }),
        (value) =>
          !value.slots.selection?.draining &&
          value.fleet.resources.every(
            (row) => row.target.imageInput === value.slots.selection?.active.target.imageInput,
          ),
        "PoolWorker.old-generation-drain",
      ),
    );
    yield* evaluate(plan(), (compiled) =>
      Effect.gen(function* () {
        const forward = yield* resumeForwardRelease(compiled, {
          directory: options.directory,
          runtime: () => client.health(),
        });
        yield* deployStack(compiled, {
          ...options,
          forwardInput: forward?.continuation,
          runtimeImage: {
            prepare: async () => {
              throw new BarrierRefusal("runtime-release-active-image-mutation", "PoolContainer");
            },
            verify: async () => {
              await client.health();
            },
          },
        });
        yield* Effect.promise(() => retainPhase("final-settings"));
        const native = yield* runtimeReleaseState(compiled);
        yield* Effect.promise(() => save({ ...record, baseline: native }));
      }),
    );
    client = yield* clientFor();
    yield* Effect.promise(() => releaseCodeReady(record.baseline, code));
    yield* Effect.promise(() =>
      releaseSelectedReady(record.baseline, code, client, record.desiredInput),
    );
    if (
      !(yield* Effect.promise(() =>
        client.selectedCurrent(record.desiredInput, record.desiredConfiguration),
      ))
    )
      throw new BarrierRefusal("runtime-release-final-startup-settings-mismatch", "PoolWorker");
    yield* Effect.promise(() => save({ ...record, complete: true }));
  });
