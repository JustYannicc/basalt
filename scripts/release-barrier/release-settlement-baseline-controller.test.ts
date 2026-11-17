// The next candidate's image record freezes its baseline controller through the same two calls
// runtime-image-release.ts init makes (journal head, then freezeBaselineController). Driving the
// whole init needs the redirected release world, so this proves those calls plus the resume step.
import assert from "node:assert/strict";
import { test } from "node:test";
import { Effect } from "effect";
import {
  controllerActiveFixture,
  planSettlement,
  type SettlementFixture,
} from "./test/settlement-plan.ts";
import { previousController } from "./test/settlement-controller.ts";
import { applyReleaseSettlement } from "./release-settlement-operation.ts";
import { releaseSettlementDigest } from "./release-settlement-contract.ts";
import { runtimeReleaseJournal } from "./runtime-release-journal.ts";
import {
  baselineControllerHealth,
  freezeBaselineController,
  type BaselineController,
} from "./baseline-controller.ts";
import { controllerForwardHealth } from "./controller-forward-health.ts";
import { readForwardPacket } from "./forward-model.ts";
import { writeForwardJournal } from "./forward-journal.ts";
import { resumeForwardRelease } from "./forward-resume.ts";
import { BarrierRefusal, canonical, digest } from "./manifest.ts";

const notInstalled = async (): Promise<never> => {
  throw new BarrierRefusal("runtime-release-controller-not-installed", "PoolWorker");
};

/** The next candidate's controller phase started uploading and stopped before its head finished. */
const interruptedControllerPhase = (f: SettlementFixture) => {
  const manifest = {
    ...f.packet.manifest,
    candidate: f.candidate,
    workers: f.packet.manifest.workers.map((worker) => ({
      ...worker,
      baseline: [...f.active.get(worker.id)!],
    })),
  };
  return readForwardPacket({
    schemaVersion: 1,
    manifest,
    frozen: { ...f.packet.frozen, candidate: f.candidate },
    receipt: {
      schemaVersion: 2,
      candidate: f.candidate,
      manifest: digest(canonical(manifest)),
      ceilingMs: 750,
      phase: "upload",
      accepted: [],
      startupMeasurements: [],
      activated: [],
      containers: [],
      pendingUpload: { worker: "PoolWorker" },
    },
    nativeBefore: f.packet.nativeBefore,
  });
};

const resumeController = (f: SettlementFixture, baseline: BaselineController) =>
  Effect.runPromise(
    f.provide(
      resumeForwardRelease(f.compiled, {
        directory: f.io.directory,
        io: { ...f.io.forward, container: f.io.container },
        runtime: (container, _observed, observation) =>
          controllerForwardHealth({
            baseline,
            container,
            observation,
            baselineHealth: () =>
              baselineControllerHealth({
                baseline,
                key: f.key,
                target: { ...baseline.target, connect: f.io.connect },
              }),
            candidateReady: notInstalled,
            candidateHealth: notInstalled,
          }),
      }),
    ),
  );

test("a candidate released by a controller-active settlement freezes the source controller the live controller holds", async (context) => {
  const f = await controllerActiveFixture(context);
  const manifest = await planSettlement(f);
  await Effect.runPromise(
    f.provide(
      applyReleaseSettlement(
        f.compiled,
        manifest,
        f.key,
        {
          coordinatorGo: "apply-reviewed-packet",
          writerLease: f.provisioningWriter.lease,
          manifest: releaseSettlementDigest(manifest),
          expiresAt: Date.now() + 60_000,
        },
        f.io,
      ),
    ),
  );
  const journal = await Effect.runPromise(
    f.provide(runtimeReleaseJournal(f.scope, f.writer(), f.key)),
  );
  const head = await journal.head();
  assert.equal(head.record, undefined);
  assert.deepEqual(head.settledController, f.code);
  const baselineController = await Effect.runPromise(
    f.provide(freezeBaselineController(f.compiled, head.settledController)),
  );
  assert.deepEqual(baselineController.versions, [
    { versionId: "accepted-PoolWorker", percentage: 100 },
  ]);
  await journal.write({ ...f.record, candidate: f.candidate, baselineController });
  const record = await journal.read();
  assert.ok(record?.baselineController);
  await Effect.runPromise(
    writeForwardJournal(f.state, f.scope, f.key, interruptedControllerPhase(f), false),
  );
  const reconciled = await resumeController(f, record.baselineController);
  assert.equal(reconciled?.before, reconciled?.after);
  assert.deepEqual(record.baselineController.code, f.code);
  assert.deepEqual(f.calls.filter((call) => call.startsWith("POST")).slice(-1), ["POST inspect"]);
});

test("a candidate after a completed release still freezes the readiness row's controller", async (context) => {
  const f = await controllerActiveFixture(context);
  const source = await Effect.runPromise(
    f.provide(runtimeReleaseJournal(f.scope, f.writer(f.sourceCandidate), f.key)),
  );
  await source.write({ ...f.record, complete: true });
  const journal = await Effect.runPromise(
    f.provide(runtimeReleaseJournal(f.scope, f.writer(), f.key)),
  );
  const head = await journal.head();
  assert.deepEqual(head, {});
  const baselineController = await Effect.runPromise(
    f.provide(freezeBaselineController(f.compiled, head.settledController)),
  );
  assert.deepEqual(
    baselineController.code,
    previousController(f.accountId, baselineController.imageHash).code,
  );
});
