import assert from "node:assert/strict";
import { test } from "node:test";
import { Effect } from "effect";
import { releaseSettlementFixture } from "./test/release-settlement-fixture.ts";
import {
  planReleaseSettlement,
  applyReleaseSettlement,
  inspectReleaseSettlement,
} from "./release-settlement-operation.ts";
import {
  releaseSettlementDigest,
  releaseSettlementKey,
  releaseImageJournalKey,
} from "./release-settlement-contract.ts";
import { openReleaseSettlement } from "./release-settlement-archive.ts";
import { runtimeReleaseJournal } from "./runtime-release-journal.ts";
import { journalKey } from "./forward-journal.ts";
import { resumeForwardRelease } from "./forward-resume.ts";
import { baselineControllerHealth, readBaselineController } from "./baseline-controller.ts";
import { planSettlement } from "./test/settlement-plan.ts";
import { canonical, digest } from "./manifest.ts";
import {
  decodeProvisioningPacket,
  provisioningOperationDigest,
  runDeclaredProvisioning,
  inspectDeclaredProvisioning,
} from "./provisioning-operation.ts";

test("a pending upload and unfinished image release are archived together before a different candidate may proceed", async (context) => {
  const f = await releaseSettlementFixture(context);
  const next = await Effect.runPromise(
    f.provide(runtimeReleaseJournal(f.scope, f.writer(), f.key)),
  );
  await assert.rejects(next.read(), /prior-candidate-unsettled/);
  const imageBefore = await Effect.runPromise(f.state.getOutput(releaseImageJournalKey(f.scope)));
  const forwardBefore = await Effect.runPromise(f.state.getOutput(journalKey(f.scope)));
  const manifest = await Effect.runPromise(
    f.provide(
      planReleaseSettlement(
        f.compiled,
        {
          kind: "release-settlement",
          sourceCandidate: f.sourceCandidate,
          operationId: "settle-before-controller",
          coordinatorGo: "read-only-plan",
          expiresAt: Date.now() + 60_000,
        },
        f.provisioningWriter,
        f.key,
        f.io,
      ),
    ),
  );
  assert.equal(f.writes(), 0);
  const receipt = await Effect.runPromise(
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
  assert.equal(receipt.stateWrites, 1);
  assert.equal(f.writes(), 1);
  assert.equal(f.intents.length, 1);
  assert.deepEqual(
    await Effect.runPromise(f.state.getOutput(releaseImageJournalKey(f.scope))),
    imageBefore,
  );
  assert.deepEqual(await Effect.runPromise(f.state.getOutput(journalKey(f.scope))), forwardBefore);
  const archive = await Effect.runPromise(
    f.state.getOutput(releaseSettlementKey(f.scope, f.sourceCandidate, f.candidate)),
  );
  const saved = openReleaseSettlement(archive, f.key, f.sourceCandidate, f.candidate);
  assert.deepEqual(saved.source, { image: imageBefore, forward: forwardBefore });
  assert.ok(!JSON.stringify(archive).includes("synthetic-management"));
  assert.equal(saved.manifest.proof.nativeBeforeDigest, saved.manifest.proof.nativeAfterDigest);
  assert.equal(
    saved.manifest.proof.workers.find((row) => row.worker === "McpServer")?.accepted,
    null,
  );
  assert.equal(await next.read(), undefined);
  const reconciled = await Effect.runPromise(
    f.provide(
      resumeForwardRelease(f.compiled, {
        directory: f.io.directory,
        io: { ...f.io.forward, container: f.io.container },
        runtime: () =>
          baselineControllerHealth({
            baseline: manifest.proof.controller,
            key: f.key,
            target: { ...manifest.proof.controller.target, connect: f.io.connect },
          }),
      }),
    ),
  );
  assert.equal(reconciled?.before, reconciled?.after);
  assert.equal(await next.read(), undefined);
  assert.deepEqual(
    openReleaseSettlement(archive, f.key, f.sourceCandidate, f.candidate).source.forward,
    forwardBefore,
  );
  const other = await Effect.runPromise(
    f.provide(runtimeReleaseJournal(f.scope, f.writer("d".repeat(40)), f.key)),
  );
  await assert.rejects(other.read(), /prior-candidate-unsettled/);
});

test("an archive cannot authorize a changed native resource", async (context) => {
  const f = await releaseSettlementFixture(context);
  const manifest = await Effect.runPromise(
    f.provide(
      planReleaseSettlement(
        f.compiled,
        {
          kind: "release-settlement",
          sourceCandidate: f.sourceCandidate,
          operationId: "settlement-native",
          coordinatorGo: "read-only-plan",
          expiresAt: Date.now() + 60_000,
        },
        f.provisioningWriter,
        f.key,
        f.io,
      ),
    ),
  );
  await Effect.runPromise(
    f.provide(
      applyReleaseSettlement(
        f.compiled,
        manifest,
        f.key,
        {
          coordinatorGo: "apply",
          writerLease: f.provisioningWriter.lease,
          manifest: releaseSettlementDigest(manifest),
          expiresAt: Date.now() + 60_000,
        },
        f.io,
      ),
    ),
  );
  const key = { stack: f.scope.name, stage: f.scope.stage, fqn: "Api" };
  const row = await Effect.runPromise(f.memory.get(key));
  assert.ok(row);
  await Effect.runPromise(
    f.memory.set({ ...key, value: { ...row, props: { changedInput: true } } }),
  );
  const next = await Effect.runPromise(
    f.provide(runtimeReleaseJournal(f.scope, f.writer(), f.key)),
  );
  await assert.rejects(next.read(), /release-settlement-archive-drift/);
  assert.equal(f.writes(), 1);
});

for (const fault of ["boot", "placement", "deployment", "expired"] as const)
  test(`settlement refuses ${fault} drift before its only State write`, async (context) => {
    const f = await releaseSettlementFixture(context);
    const manifest = await Effect.runPromise(
      f.provide(
        planReleaseSettlement(
          f.compiled,
          {
            kind: "release-settlement",
            sourceCandidate: f.sourceCandidate,
            operationId: "settlement-proof",
            coordinatorGo: "read-only-plan",
            expiresAt: Date.now() + 60_000,
          },
          f.provisioningWriter,
          f.key,
          f.io,
        ),
      ),
    );
    if (fault === "boot") f.changeBoot();
    if (fault === "placement") f.changePlacement();
    if (fault === "deployment")
      f.active.set("McpServer", [{ versionId: "unconfirmed-upload", percentage: 100 }]);
    await assert.rejects(
      Effect.runPromise(
        f.provide(
          applyReleaseSettlement(
            f.compiled,
            manifest,
            f.key,
            {
              coordinatorGo: "apply",
              writerLease: f.provisioningWriter.lease,
              manifest: releaseSettlementDigest(manifest),
              expiresAt: Date.now() + (fault === "expired" ? -1 : 60_000),
            },
            f.io,
          ),
        ),
      ),
    );
    assert.equal(f.writes(), 0);
  });

test("an unknown archive acknowledgement is inspected without replaying the State mutation", async (context) => {
  const f = await releaseSettlementFixture(context);
  const manifest = await Effect.runPromise(
    f.provide(
      planReleaseSettlement(
        f.compiled,
        {
          kind: "release-settlement",
          sourceCandidate: f.sourceCandidate,
          operationId: "settlement-unknown",
          coordinatorGo: "read-only-plan",
          expiresAt: Date.now() + 60_000,
        },
        f.provisioningWriter,
        f.key,
        f.io,
      ),
    ),
  );
  const enable = {
    coordinatorGo: "apply",
    writerLease: f.provisioningWriter.lease,
    manifest: releaseSettlementDigest(manifest),
    expiresAt: Date.now() + 60_000,
  };
  f.failWrite();
  await assert.rejects(
    Effect.runPromise(f.provide(applyReleaseSettlement(f.compiled, manifest, f.key, enable, f.io))),
    /unconfirmed-inspect-required/,
  );
  const calls = f.calls.length;
  const inspected = await Effect.runPromise(
    f.provide(inspectReleaseSettlement(f.scope, manifest, f.key)),
  );
  assert.equal(inspected.disposition, "archived");
  await assert.rejects(
    Effect.runPromise(f.provide(applyReleaseSettlement(f.compiled, manifest, f.key, enable, f.io))),
    /already-recorded-inspect-required/,
  );
  assert.equal(f.writes(), 1);
  assert.equal(f.calls.length, calls);
});

test("the main provisioning path validates the exact settlement packet and inspects without replay", async (context) => {
  const f = await releaseSettlementFixture(context);
  const manifest = await Effect.runPromise(
    f.provide(
      planReleaseSettlement(
        f.compiled,
        {
          kind: "release-settlement",
          sourceCandidate: f.sourceCandidate,
          operationId: "settlement-main-path",
          coordinatorGo: "read-only-plan",
          expiresAt: Date.now() + 60_000,
        },
        f.provisioningWriter,
        f.key,
        f.io,
      ),
    ),
  );
  const operation = { kind: "release-settlement" as const, manifest };
  const packet = decodeProvisioningPacket({
    operation,
    go: {
      coordinatorGo: "reviewed-apply",
      manifest: provisioningOperationDigest(operation),
      expiresAt: Date.now() + 60_000,
    },
  });
  await assert.rejects(
    Effect.runPromise(
      f
        .provide(
          runDeclaredProvisioning(
            f.compiled,
            packet,
            { ...f.provisioningWriter, candidate: "d".repeat(40) },
            f.key,
            "",
            { settlement: f.io },
          ),
        )
        .pipe(Effect.provideContext(f.compiled.services)),
    ),
  );
  assert.equal(f.writes(), 0);
  const receipt = await Effect.runPromise(
    f
      .provide(
        runDeclaredProvisioning(f.compiled, packet, f.provisioningWriter, f.key, "", {
          settlement: f.io,
        }),
      )
      .pipe(Effect.provideContext(f.compiled.services)),
  );
  assert.equal("stateWrites" in receipt ? receipt.stateWrites : undefined, 1);
  const calls = f.calls.length;
  const inspection = await Effect.runPromise(
    f.provide(inspectDeclaredProvisioning(f.compiled, packet, f.provisioningWriter, f.key)),
  );
  assert.equal("disposition" in inspection ? inspection.disposition : undefined, "archived");
  assert.equal(f.calls.length, calls);
  assert.equal(f.writes(), 1);
});

test("an abandoned source settles against the controller its image record froze, not a stale readiness row", async (context) => {
  const f = await releaseSettlementFixture(context, { staleReadiness: true });
  const recorded = await Effect.runPromise(f.provide(readBaselineController(f.scope)));
  assert.notDeepEqual(recorded.code, f.code);
  const manifest = await planSettlement(f, "omitted");
  assert.equal(manifest.proof.disposition, "abandoned-before-controller");
  assert.deepEqual(manifest.proof.controller, { ...recorded, code: f.code });
  assert.deepEqual(
    f.runtimeReads.map((call) => `${call.method} ${call.action ?? call.path}`),
    ["POST inspect", "GET /runtime-recovery"],
  );
  const receipt = await Effect.runPromise(
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
  assert.equal(receipt.stateWrites, 1);
});

test("an abandoned source without a frozen controller keeps the readiness row's controller", async (context) => {
  const f = await releaseSettlementFixture(context);
  const recorded = await Effect.runPromise(f.provide(readBaselineController(f.scope)));
  const manifest = await planSettlement(f, "omitted");
  assert.deepEqual(manifest.proof.controller, recorded);
  // The proof this fixture produced before the frozen controller was read; it must not move.
  assert.equal(
    digest(canonical(manifest.proof)),
    "ac98394c0c862691e7fbb50f749d835546e00ce210528085e1b2075ba1e5d4ae",
  );
});
