// The next candidate's image record freezes its baseline controller through the calls
// runtime-image-release.ts init makes (journal head, then the read releaseBaselineController
// makes with its code). The full init runs only in the redirected release world
// (runtime-image-release.test.ts), so this proves those calls against the real journal and
// archive, plus the resume step against the real handler.
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
  readBaselineController,
  type BaselineController,
} from "./baseline-controller.ts";
import { controllerForwardHealth } from "./controller-forward-health.ts";
import { readForwardPacket } from "./forward-model.ts";
import { writeForwardJournal } from "./forward-journal.ts";
import { resumeForwardRelease } from "./forward-resume.ts";
import { BarrierRefusal, canonical, digest } from "./manifest.ts";
import { runtimeProofFixture } from "./test/runtime-proof-fixture.ts";

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

/**
 * Freezes the next candidate's baseline as init does, interrupts its controller phase mid-upload,
 * and resumes it. The readiness row's code is refused by the live controller; the frozen one is not.
 */
async function freezeAndResume(f: SettlementFixture) {
  const journal = await Effect.runPromise(
    f.provide(runtimeReleaseJournal(f.scope, f.writer(), f.key)),
  );
  const head = await journal.head();
  assert.equal(head.record, undefined);
  assert.deepEqual(head.sourceController, f.code);
  const baselineController = await Effect.runPromise(
    f.provide(readBaselineController(f.compiled, head.sourceController)),
  );
  assert.deepEqual(baselineController.versions, [
    { versionId: "accepted-PoolWorker", percentage: 100 },
  ]);
  await journal.write({ ...f.record, candidate: f.candidate, baselineController });
  const record = await journal.read();
  assert.ok(record?.baselineController);
  assert.deepEqual(record.baselineController.code, f.code);
  await Effect.runPromise(
    writeForwardJournal(f.state, f.scope, f.key, interruptedControllerPhase(f), false),
  );
  const stale = await Effect.runPromise(f.provide(readBaselineController(f.compiled)));
  await assert.rejects(
    resumeController(f, stale),
    /baseline-controller-identity-refused \(PoolWorker\)/,
  );
  const reconciled = await resumeController(f, record.baselineController);
  assert.equal(reconciled?.before, reconciled?.after);
  assert.deepEqual(f.calls.filter((call) => call.startsWith("POST")).slice(-1), ["POST inspect"]);
}

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
  await freezeAndResume(f);
});

test("a candidate after an aborted release freezes the controller that confirmed the abort", async (context) => {
  const f = await controllerActiveFixture(context);
  const proof = await runtimeProofFixture();
  const startup = { ...proof.manifest, candidate: f.sourceCandidate, controllerCode: f.code };
  const source = await Effect.runPromise(
    f.provide(runtimeReleaseJournal(f.scope, f.writer(f.sourceCandidate), f.key)),
  );
  await source.write({
    ...f.record,
    promotion: { operationId: startup.operationId, pool: "synthetic-pool", generation: 0, startup },
    abort: {
      intent: {
        operationId: "operator-abort",
        target: startup.target,
        witness: proof.witness,
        startupOperationId: startup.operationId,
        expectedEpoch: startup.selection.expectedEpoch,
        active: startup.selection.active!,
      },
      status: "aborted",
      sent: true,
    },
  });
  await freezeAndResume(f);
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
    f.provide(readBaselineController(f.compiled, head.sourceController)),
  );
  assert.deepEqual(
    baselineController.code,
    previousController(f.accountId, baselineController.imageHash).code,
  );
});
