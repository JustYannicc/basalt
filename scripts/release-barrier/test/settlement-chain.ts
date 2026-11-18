import assert from "node:assert/strict";
import { Effect } from "effect";
import type { RuntimeColor } from "../../../src/pool/image-release-plan.ts";
import { readBaselineController } from "../baseline-controller.ts";
import { writeForwardJournal } from "../forward-journal.ts";
import { readForwardPacket } from "../forward-model.ts";
import { canonical, digest } from "../manifest.ts";
import { applyReleaseSettlement, planReleaseSettlement } from "../release-settlement-operation.ts";
import { releaseSettlementDigest } from "../release-settlement-contract.ts";
import { runtimeReleaseJournal } from "../runtime-release-journal.ts";
import { runtimeReleaseState } from "../runtime-release-state.ts";
import { bootstrapManifest } from "./settlement-bootstrap.ts";
import { activatedReceipt } from "./settlement-controller.ts";
import type { SettlementFixture } from "./settlement-plan.ts";

type Manifest = Awaited<ReturnType<typeof planFrom>>;
/** A reviewed plan settling `source` for the release `writer` names. */
export const planFrom = (
  f: SettlementFixture,
  source: { candidate: string; code: typeof f.code },
  writer: string,
  disposition:
    | "fleet-attached-unstarted"
    | "controller-active-adopted" = "fleet-attached-unstarted",
) =>
  Effect.runPromise(
    f.provide(
      planReleaseSettlement(
        f.compiled,
        {
          kind: "release-settlement",
          coordinatorGo: "read-only-plan",
          disposition,
          sourceCandidate: source.candidate,
          operationId: `settle-${source.candidate.slice(0, 8)}`,
          expiresAt: Date.now() + 60_000,
          sourceController: source.code,
        },
        { ...f.provisioningWriter, candidate: writer },
        f.key,
        f.io,
      ),
    ),
  );

/** That plan's apply under its own reviewed GO. */
export const applyFrom = (f: SettlementFixture, manifest: Manifest) =>
  Effect.runPromise(
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

/**
 * Next candidate `next` released after the source's archive freed it, as runtime-image-release.ts
 * does: init froze the controller the archive proved live and the native baseline, which holds the
 * source's fleet applications, so it skipped their bootstrap. Its controller phase then activated
 * every Worker and its own controller, and bound every native colour. `bootstrap` names colours
 * it went on to create itself. It then stopped before any startup.
 */
export async function adoptingRelease(
  f: SettlementFixture,
  next: { candidate: string; code: typeof f.code; bootstrap?: readonly RuntimeColor[] },
) {
  const journal = await Effect.runPromise(
    f.provide(runtimeReleaseJournal(f.scope, f.writer(next.candidate), f.key)),
  );
  const head = await journal.head();
  assert.equal(head.record, undefined);
  assert.deepEqual(head.sourceController, f.code);
  const baselineController = await Effect.runPromise(
    f.provide(readBaselineController(f.compiled, head.sourceController)),
  );
  for (const color of next.bootstrap ?? []) await f.attachFleet(color, next.candidate);
  const baseline = await Effect.runPromise(f.provide(runtimeReleaseState(f.scope)));
  await journal.write({
    ...f.record,
    candidate: next.candidate,
    baseline,
    baselineController,
    bootstrap: Object.fromEntries(
      (next.bootstrap ?? []).map((color) => [
        color,
        bootstrapManifest({
          color,
          source: next.candidate,
          accountId: f.accountId,
          rootApplicationId: "pool-app",
          epoch: 1,
        }),
      ]),
    ),
    configurations: {},
  });
  const workers = f.packet.manifest.workers.map((worker) => ({
    ...worker,
    baseline: [...f.active.get(worker.id)!],
  }));
  const manifest = { ...f.packet.manifest, candidate: next.candidate, workers };
  const receipt = activatedReceipt(
    workers.map((worker) => worker.id),
    f.packet.receipt.containers![0]!.version,
    `next-${next.candidate.slice(0, 4)}`,
  );
  await Effect.runPromise(
    writeForwardJournal(
      f.state,
      f.scope,
      f.key,
      readForwardPacket({
        schemaVersion: 1,
        manifest,
        frozen: { ...f.packet.frozen, candidate: next.candidate },
        receipt: {
          schemaVersion: 2,
          candidate: next.candidate,
          manifest: digest(canonical(manifest)),
          ceilingMs: 750,
          ...receipt,
        },
        nativeBefore: f.packet.nativeBefore,
      }),
      true,
    ),
  );
  for (const row of receipt.activated)
    f.active.set(row.worker, [{ versionId: row.versionId, percentage: 100 }]);
  f.controller.activate(next.code);
  // Its code phase binds every native colour; any permission its source configured stays live.
  f.controller.fleet = {
    ...f.controller.fleet,
    bindings: (["blue", "green"] as const).flatMap((color) => {
      const application = baseline.applications[color];
      return application
        ? [
            {
              color,
              applicationId: application.attributes.applicationId,
              imageInput: application.image.inputHash,
            },
          ]
        : [];
    }),
  };
}
