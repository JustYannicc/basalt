import assert from "node:assert/strict";
import type { TestContext } from "node:test";
import { Effect } from "effect";
import { controllerRecoveredFixture, type SettlementFixture } from "./settlement-plan.ts";
import { applyReleaseSettlement, planReleaseSettlement } from "../release-settlement-operation.ts";
import {
  releaseSettlementDigest,
  type ReleaseSettlementDisposition,
  type ReleaseSettlementManifest,
} from "../release-settlement-contract.ts";
import { journalKey } from "../forward-journal.ts";
import { releaseBaselineController } from "../baseline-controller.ts";
import { runtimeReleaseState } from "../runtime-release-state.ts";
import { runtimeReleaseJournal, type RuntimeReleaseRecord } from "../runtime-release-journal.ts";

// The fixture's source "a" is the prior production candidate, its target "c" the release that
// stopped in its controller phase's preparation, and "d" the next candidate.
export const next = "d".repeat(40);

export const settle = async (
  f: SettlementFixture,
  source: string,
  target: string,
  disposition: ReleaseSettlementDisposition,
  sourceController?: typeof f.code,
) => {
  const writer = { ...f.provisioningWriter, candidate: target };
  const manifest = await Effect.runPromise(
    f.provide(
      planReleaseSettlement(
        f.compiled,
        {
          kind: "release-settlement",
          sourceCandidate: source,
          operationId: `settle-${disposition}`,
          coordinatorGo: "read-only-plan",
          expiresAt: Date.now() + 60_000,
          disposition,
          ...(sourceController ? { sourceController } : {}),
        },
        writer,
        f.key,
        f.io,
      ),
    ),
  );
  return {
    manifest,
    apply: (planned: ReleaseSettlementManifest = manifest) =>
      Effect.runPromise(
        f.provide(
          applyReleaseSettlement(
            f.compiled,
            planned,
            f.key,
            {
              coordinatorGo: "apply-reviewed-packet",
              writerLease: writer.lease,
              manifest: releaseSettlementDigest(planned),
              expiresAt: Date.now() + 60_000,
            },
            f.io,
          ),
        ),
      ),
  };
};

/**
 * Production's state: the prior candidate settled as controller-active-adopted onto the stopped
 * release, whose init then froze its image record from that archive and whose controller phase
 * failed in deploy preparation before freezing a manifest, so the forward head never moved.
 */
export async function stoppedBeforeForward(context: TestContext) {
  const f = await controllerRecoveredFixture(context);
  const archived = await settle(
    f,
    f.sourceCandidate,
    f.candidate,
    "controller-active-adopted",
    f.code,
  );
  await archived.apply();
  const forwardBefore = await Effect.runPromise(f.state.getOutput(journalKey(f.scope)));
  // The stopped release's own init, runtime-image-release.ts: head, baseline controller, record.
  const journal = await Effect.runPromise(
    f.provide(runtimeReleaseJournal(f.scope, f.writer(f.candidate), f.key)),
  );
  const head = await journal.head();
  assert.equal(head.record, undefined);
  assert.deepEqual(head.sourceController, f.code);
  const { controller } = await Effect.runPromise(
    f.provide(releaseBaselineController(f.scope, head)),
  );
  assert.deepEqual(controller.code, f.code);
  const baseline = await Effect.runPromise(f.provide(runtimeReleaseState(f.scope)));
  const record: RuntimeReleaseRecord = {
    format: "pool-image-release-v1",
    candidate: f.candidate,
    complete: false,
    baseline,
    baselineController: controller,
    desiredInput: f.record.desiredInput,
    desiredConfiguration: f.record.desiredConfiguration,
    bootstrap: {},
    configurations: {},
  };
  await journal.write(record);
  // A resumed run finds its own record; preparation failed before any forward write.
  assert.equal((await journal.head()).record?.candidate, f.candidate);
  assert.deepEqual(await Effect.runPromise(f.state.getOutput(journalKey(f.scope))), forwardBefore);
  return { f, record, controller };
}
