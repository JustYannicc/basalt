import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Cause, ConfigProvider, Effect, Exit, Layer, Schema } from "effect";
import { State, type PersistedState, type StateService } from "alchemy/State/State";
import { InMemoryService } from "alchemy/State/InMemoryState";
import { encodeState } from "alchemy/State/StateEncoding";
import { Stack, evalStack } from "alchemy/Stack";
import { releaseWorkers, type BarrierReceipt } from "./barrier.ts";
import { BarrierRefusal, describeWorker, manifestDigest } from "./manifest.ts";
import { describeContainer } from "./container.ts";
import { readForwardPacket, encodedRecordHash, forwardAdoption } from "./forward-model.ts";
import {
  writeForwardJournal,
  readForwardJournal,
  beginForwardJournal,
  journalKey,
  containerKey,
} from "./forward-journal.ts";
import { resumeForwardRelease } from "./forward-resume.ts";
import { openRecovery } from "./recovery-envelope.ts";
import { withReleaseRuntime } from "./runtime.ts";
import { attributes } from "./fixture.ts";
import { containerRelease } from "./test/container-fixture.ts";
import { refusalTable } from "./refusal-report.ts";

const encryptionKey = "f".repeat(64);
const newCandidate = "b".repeat(40);
const header = {
  candidate: Schema.String,
  manifest: Schema.String,
  complete: Schema.Boolean,
  sealed: Schema.Unknown,
};
const readHeader = Schema.decodeUnknownSync(
  Schema.Struct({
    schemaVersion: Schema.Literal(1),
    ...header,
    previous: Schema.optional(Schema.Struct(header)),
  }),
);

for (const scenario of ["baseline", "worker-drift", "unchanged-image"])
  test(
    scenario === "worker-drift"
      ? "new candidate refuses unrelated live Worker drift before replacing an older incomplete journal"
      : scenario === "unchanged-image"
        ? "new image release resumes an unchanged-image failure without an adoption write"
        : "new candidate resumes an older incomplete baseline journal before starting and completing its own release",
    async (context) => {
      const directory = await mkdtemp(join(tmpdir(), "journal-candidate-"));
      context.after(() => rm(directory, { recursive: true, force: true }));
      const fixture = containerRelease();
      const drift = scenario === "worker-drift";
      const unchanged = scenario === "unchanged-image";
      const oldCandidate = fixture.manifest.candidate;
      assert.notEqual(oldCandidate, newCandidate);
      const oldSource = {
        ...fixture.manifest,
        containers: unchanged
          ? [
              {
                ...fixture.frozen,
                configuration: fixture.previous.configuration,
                inputHash: fixture.frozen.baselineInputHash,
                imageDigest: fixture.previous.hash!.digest!,
                rolloutRequest: {
                  ...fixture.frozen.rolloutRequest,
                  targetConfiguration: fixture.previous.configuration,
                },
              },
            ]
          : fixture.manifest.containers,
      };
      const oldManifest = {
        ...oldSource,
        workers: oldSource.workers.map(describeWorker),
        containers: oldSource.containers!.map(describeContainer),
      };
      const oldReceipt: BarrierReceipt = {
        schemaVersion: 2,
        candidate: oldCandidate,
        manifest: manifestDigest(oldSource),
        ceilingMs: 750,
        phase: unchanged ? "container-activation" : "activation",
        accepted: fixture.manifest.workers.map((worker) => ({
          worker: worker.id,
          versionId: `unserved-${worker.id}`,
          startupTimeMs: 100,
        })),
        activated: unchanged
          ? fixture.manifest.workers.map((worker) => ({
              worker: worker.id,
              versionId: `unserved-${worker.id}`,
            }))
          : [],
        containers: unchanged
          ? [{ container: "PoolContainer", version: fixture.previous.version, unchanged: true }]
          : [],
        ...(unchanged
          ? {
              pendingContainer: {
                container: "PoolContainer",
                phase: "verification" as const,
                version: fixture.previous.version,
              },
            }
          : { pending: { worker: "Api", versionId: "unserved-Api" } }),
        failure: unchanged
          ? { reason: "container-serving-not-verified", worker: "PoolContainer" }
          : { reason: "placement-repair-baseline-drift", worker: "Api" },
      };
      const saved: PersistedState = {
        resourceType: "Cloudflare.Container",
        namespace: undefined,
        fqn: "PoolContainer",
        logicalId: "PoolContainer",
        instanceId: "synthetic",
        providerVersion: 1,
        status: "updated",
        downstream: ["PoolWorker"],
        bindings: [],
        props: {},
        attr: fixture.previous,
      };
      const packet = readForwardPacket({
        schemaVersion: 1,
        manifest: oldManifest,
        frozen: { ...oldManifest, containers: oldSource.containers },
        receipt: oldReceipt,
        nativeBefore: encodeState(saved),
      });
      if (unchanged) {
        assert.equal(packet.adoption, undefined);
        assert.throws(
          () =>
            forwardAdoption(
              {
                ...packet,
                adoption: {
                  before: "c".repeat(64),
                  after: "d".repeat(64),
                  backup: {},
                },
              },
              saved,
              fixture.previous,
            ),
          /forward-native-after-drift/u,
        );
        assert.throws(
          () => forwardAdoption(packet, { ...saved, downstream: [] }, fixture.previous),
          (error) => {
            assert.ok(error instanceof BarrierRefusal);
            assert.equal(error.reason, "forward-native-after-drift");
            const table = refusalTable(error);
            assert.ok(table.includes(encodedRecordHash(saved)));
            assert.ok(table.includes(encodedRecordHash({ ...saved, downstream: [] })));
            assert.match(table, /native.recordHash/);
            assert.match(table, /journal.adoption.before/);
            assert.match(table, /journal.adoption.after/);
            assert.match(table, /neither an exact unchanged native baseline nor a journaled/);
            return true;
          },
        );
      }
      await Effect.runPromise(
        Effect.gen(function* () {
          const memory = yield* InMemoryService();
          let resourceWrites = 0;
          const state: StateService = {
            ...memory,
            set: (request) =>
              memory.set(request).pipe(
                Effect.tap(() =>
                  Effect.sync(() => {
                    resourceWrites++;
                  }),
                ),
              ),
          };
          const scope = { name: "basalt", stage: "production" };
          yield* memory.set({ ...containerKey(scope), value: saved });
          for (const worker of fixture.manifest.workers)
            yield* memory.set({
              stack: scope.name,
              stage: scope.stage,
              fqn: worker.id,
              value: {
                resourceType: "Cloudflare.Worker",
                namespace: undefined,
                fqn: worker.id,
                logicalId: worker.id,
                instanceId: `synthetic-${worker.id}`,
                providerVersion: 1,
                status: "updated",
                downstream: [],
                bindings: [],
                props: {},
                attr: attributes(worker.scriptName),
              },
            });
          yield* writeForwardJournal(state, scope, encryptionKey, packet, false);
          const originalHeader = yield* state.getOutput(journalKey(scope));
          assert.equal(readHeader(originalHeader).complete, false);
          const stack = Stack(
            scope.name,
            { providers: Layer.empty, state: Layer.succeed(State, Effect.succeed(state)) },
            Effect.void,
          );
          return yield* evalStack(
            stack,
            (compiled) =>
              Effect.gen(function* () {
                const resume = resumeForwardRelease(compiled, {
                  directory,
                  io: {
                    baseline: (worker) =>
                      Effect.succeed(
                        drift && worker.scriptName === "Api"
                          ? [{ versionId: "unrelated", percentage: 100 }]
                          : fixture.manifest.workers
                              .find((item) => item.scriptName === worker.scriptName)!
                              .baseline.map((version) => ({ ...version })),
                      ),
                    container: () => Effect.succeed(fixture.previous),
                    observation: async () => ({
                      version: fixture.previous.version,
                      digest: fixture.previous.hash!.digest!,
                      instances: [
                        {
                          id: "synthetic-instance",
                          state: "running",
                          digest: fixture.previous.hash!.digest!,
                          startedAt: Date.parse("2026-11-08T00:00:00Z"),
                        },
                      ],
                    }),
                    health: async () => ({
                      instanceId: "synthetic-instance",
                      bootId: "synthetic-boot",
                      checkedAt: 1,
                    }),
                  },
                });
                if (drift) {
                  const exit = yield* Effect.exit(resume);
                  assert.ok(Exit.isFailure(exit));
                  const error = Cause.squash(exit.cause);
                  assert.ok(error instanceof BarrierRefusal);
                  assert.equal(error.reason, "forward-worker-drift");
                  assert.deepEqual(yield* state.getOutput(journalKey(scope)), originalHeader);
                  assert.equal(resourceWrites, 0);
                  return;
                }
                const result = yield* resume;
                assert.ok(result);
                assert.equal(result.candidate, oldCandidate);
                assert.equal(result.disposition, "baseline");
                assert.equal(result.before, result.after);
                assert.equal(result.continuation, undefined);
                assert.equal(resourceWrites, 0);
                const completedOld = readHeader(yield* state.getOutput(journalKey(scope)));
                assert.equal(completedOld.candidate, oldCandidate);
                assert.equal(completedOld.complete, true);
                assert.equal(
                  encodedRecordHash(yield* state.get(containerKey(scope))),
                  encodedRecordHash(saved),
                );
                const nextManifest = { ...fixture.manifest, candidate: newCandidate };
                const nextJournal = yield* beginForwardJournal(
                  compiled,
                  nextManifest,
                  encryptionKey,
                );
                assert.ok(nextJournal);
                let records = 0;
                yield* Effect.tryPromise({
                  try: () =>
                    releaseWorkers(nextManifest, {
                      ...fixture.options,
                      record: async (receipt) => {
                        await Effect.runPromise(nextJournal.record(receipt));
                        if (records++ === 0) {
                          const stored = readHeader(
                            await Effect.runPromise(state.getOutput(journalKey(scope))),
                          );
                          assert.equal(stored.candidate, newCandidate);
                          assert.equal(stored.complete, false);
                          assert.ok(stored.previous);
                          assert.equal(stored.previous.candidate, oldCandidate);
                          assert.equal(stored.previous.complete, true);
                          const retained = readForwardPacket(
                            openRecovery(
                              stored.previous.sealed,
                              encryptionKey,
                              oldCandidate,
                              stored.previous.manifest,
                            ),
                          );
                          assert.equal(retained.receipt.manifest, oldReceipt.manifest);
                          assert.equal(
                            fixture.events.some((event) => event.startsWith("activate:")),
                            false,
                          );
                        }
                      },
                    }),
                  catch: (error) => error,
                });
                yield* nextJournal.finish();
                const final = readHeader(yield* state.getOutput(journalKey(scope)));
                assert.equal(final.candidate, newCandidate);
                assert.equal(final.complete, true);
                assert.equal(final.previous?.candidate, oldCandidate);
                assert.equal(final.previous?.complete, true);
                assert.equal((yield* readForwardJournal(compiled, encryptionKey))?.complete, true);
              }).pipe(Effect.provideService(State, Effect.succeed(state))),
            { stage: scope.stage },
          );
        }).pipe(
          withReleaseRuntime,
          Effect.provide(
            ConfigProvider.layer(
              ConfigProvider.fromEnv({
                env: {
                  EXECUTOR_ENCRYPTION_KEY: encryptionKey,
                  CLOUDFLARE_API_TOKEN: "synthetic-token",
                },
              }),
            ),
          ),
        ),
      );
    },
  );
