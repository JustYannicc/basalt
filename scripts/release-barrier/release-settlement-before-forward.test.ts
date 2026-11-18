import assert from "node:assert/strict";
import { test } from "node:test";
import { Effect } from "effect";
import { next, settle, stoppedBeforeForward } from "./test/settlement-before-forward.ts";
import { releaseImageJournalKey } from "./release-settlement-contract.ts";
import { forwardHeadCandidate, journalKey } from "./forward-journal.ts";
import { readForwardPacket, type ForwardPacket } from "./forward-model.ts";
import { openRecovery } from "./recovery-envelope.ts";
import { releaseBaselineController } from "./baseline-controller.ts";
import {
  decodeRuntimeReleaseHead,
  runtimeReleaseJournal,
  type RuntimeReleaseRecord,
} from "./runtime-release-journal.ts";
import { settlementSourceFailure } from "./release-settlement-source.ts";
import { slotSelectionKey } from "../../src/pool/runtime-slots/storage.ts";

test("a release that stopped before its forward packet is refused by every earlier disposition", async (context) => {
  const { f } = await stoppedBeforeForward(context);
  const writes = f.writes();
  for (const [disposition, refused] of [
    ["abandoned-before-controller", /release-settlement-not-pre-controller \(PoolWorker\)/],
    [
      "controller-active-adopted",
      /release-settlement-not-controller-active \(forward\.candidate\)/,
    ],
    [
      "controller-active-unadopted",
      /release-settlement-not-controller-active \(forward\.candidate\)/,
    ],
  ] as const)
    await assert.rejects(
      settle(f, f.candidate, next, disposition, { ...f.code, candidate: f.candidate }),
      refused,
    );
  assert.equal(f.writes(), writes);
});

test("abandoned-before-forward archives the stopped release and the next one starts on the live code", async (context) => {
  const { f, controller } = await stoppedBeforeForward(context);
  const writes = f.writes();
  const reads = f.runtimeReads.length;
  // The source never ran its own controller, so it names none.
  await assert.rejects(
    settle(f, f.candidate, next, "abandoned-before-forward", f.code),
    /release-settlement-source-controller-unproven/,
  );
  const planned = await settle(f, f.candidate, next, "abandoned-before-forward");
  assert.equal(f.writes(), writes);
  const { proof } = planned.manifest;
  assert.ok(proof.disposition === "abandoned-before-forward");
  assert.deepEqual(proof.controller, controller);
  assert.equal(proof.controllerReads.witness, "recovered-restart");
  assert.equal(proof.controllerReads.selection.epoch, 3);
  assert.ok(
    !f.runtimeReads.slice(reads).some((call) => call.method === "GET"),
    "an adopted root answers only signed handoff reads",
  );
  const receipt = await planned.apply();
  assert.equal(receipt.stateWrites, 1);
  assert.equal(receipt.runtimeMutations, 0);
  assert.equal(f.writes(), writes + 1);
  // The next candidate's init: its head names the live code, so its baseline reads sign with it.
  const journal = await Effect.runPromise(
    f.provide(runtimeReleaseJournal(f.scope, f.writer(next), f.key)),
  );
  const head = await journal.head();
  assert.equal(head.record, undefined);
  assert.deepEqual(head.sourceController, f.code);
  const chosen = await Effect.runPromise(f.provide(releaseBaselineController(f.scope, head)));
  assert.equal(chosen.source, "journal-source");
  assert.deepEqual(chosen.controller.code, f.code);
  // Only the archive's own target is released.
  const other = await Effect.runPromise(
    f.provide(runtimeReleaseJournal(f.scope, f.writer("e".repeat(40)), f.key)),
  );
  await assert.rejects(other.read(), /prior-candidate-unsettled/);
});

test("abandoned-before-forward refuses a selection that moved between plan and apply", async (context) => {
  const { f } = await stoppedBeforeForward(context);
  const planned = await settle(f, f.candidate, next, "abandoned-before-forward");
  const writes = f.writes();
  await f.controller.restart("recovered-boot-3");
  await assert.rejects(planned.apply(), /release-settlement-plan-drift \(PoolWorker\)/);
  f.controller.finalInspect = async (live) => {
    await f.controller.restart("recovered-boot-4");
    return live();
  };
  await assert.rejects(
    settle(f, f.candidate, next, "abandoned-before-forward"),
    /release-settlement-selection-changed \(selection\.epoch\)/,
  );
  f.controller.finalInspect = undefined;
  f.controller.storage.values.delete(slotSelectionKey);
  await assert.rejects(
    settle(f, f.candidate, next, "abandoned-before-forward"),
    /release-settlement-adopted-selection-unexpected \(selection\.absent\)/,
  );
  assert.equal(f.writes(), writes);
});

test("abandoned-before-forward refuses a frozen record that names no live controller", async (context) => {
  const { f, record } = await stoppedBeforeForward(context);
  const journal = await Effect.runPromise(
    f.provide(runtimeReleaseJournal(f.scope, f.writer(f.candidate), f.key)),
  );
  const { baselineController: _, ...withoutController } = record;
  await journal.write(withoutController);
  await assert.rejects(
    settle(f, f.candidate, next, "abandoned-before-forward"),
    /release-settlement-not-before-forward \(record\.baselineController\)/,
  );
});

test("abandoned-before-forward refuses a frozen controller other than the one it proves", async (context) => {
  const { f, record } = await stoppedBeforeForward(context);
  const journal = await Effect.runPromise(
    f.provide(runtimeReleaseJournal(f.scope, f.writer(f.candidate), f.key)),
  );
  // Same code, so the source guards pass, but not the controller the readiness row describes.
  await journal.write({
    ...record,
    baselineController: { ...record.baselineController!, readinessDigest: "other" },
  });
  await assert.rejects(
    settle(f, f.candidate, next, "abandoned-before-forward"),
    /release-settlement-not-before-forward \(record\.baselineController\)/,
  );
});

/** A class history entry as class preparation saves it, before any clone or deploy finished. */
const classEntry = (candidate: string, status: string, clone: string) => {
  const hash = "a".repeat(64);
  const observation = {
    workerId: "worker",
    accountId: "account",
    scriptName: "script",
    versionId: "version",
    settings: {},
    previewUrlsEnabled: false,
  };
  return {
    entry: hash,
    declaration: hash,
    candidate,
    native: { instanceId: "instance", workerId: "worker", providerVersion: 1 },
    baseline: observation,
    marker: "marker",
    content: hash,
    payload: hash,
    tags: [],
    recovery: { metadata: {}, mainModule: "index.js", files: [] },
    clone: { request: { accountId: "account", workerId: "worker" }, payload: hash, status: clone },
    status,
  };
};

test("abandoned-before-forward refuses class history its source saved, and pins what it read", async (context) => {
  const { f } = await stoppedBeforeForward(context);
  const scope = { stack: f.scope.name, stage: f.scope.stage };
  const output = await Effect.runPromise(f.state.getOutput(scope));
  const seed = (entries: Record<string, unknown>) =>
    Effect.runPromise(
      f.state.setOutput({
        ...scope,
        value: { ...(output as object), $basaltDeclaredClasses: entries },
      }),
    );
  // class-clone.ts saves clone-pending before staging; declared-classes.ts saves pending.
  for (const entry of [
    classEntry(f.candidate, "clone-pending", "pending"),
    classEntry(f.candidate, "pending", "ready"),
    classEntry(f.sourceCandidate, "pending", "ready"),
    classEntry(f.candidate, "ready", "removed"),
    classEntry(f.candidate, "clone-ready", "pending"),
    classEntry(f.sourceCandidate, "acknowledged", "removed"),
  ]) {
    await seed({ PoolWorker: entry });
    await assert.rejects(
      settle(f, f.candidate, next, "abandoned-before-forward"),
      /release-settlement-not-before-forward \(record\.classHistory\)/,
      `${entry.candidate} ${entry.status}`,
    );
  }
  // An earlier release's settled class history stays, pinned by the archive.
  await seed({ PoolWorker: classEntry(f.sourceCandidate, "ready", "removed") });
  const planned = await settle(f, f.candidate, next, "abandoned-before-forward");
  assert.ok(planned.manifest.proof.disposition === "abandoned-before-forward");
  await planned.apply();
  const journal = await Effect.runPromise(
    f.provide(runtimeReleaseJournal(f.scope, f.writer(next), f.key)),
  );
  assert.deepEqual((await journal.head()).sourceController, f.code);
  await seed({ PoolWorker: classEntry(f.sourceCandidate, "ready", "ready") });
  await assert.rejects(journal.head(), /release-settlement-archive-drift/);
});

test("the preflight verdict reads the forward head's candidate only from an ordinary release", async (context) => {
  const { f } = await stoppedBeforeForward(context);
  const forward = await Effect.runPromise(f.state.getOutput(journalKey(f.scope)));
  assert.equal(forwardHeadCandidate(forward), f.sourceCandidate);
  // A runtime-provisioning head also carries a plain candidate, but it names no ordinary release.
  assert.equal(
    forwardHeadCandidate({
      schemaVersion: 2,
      kind: "runtime-provisioning",
      candidate: f.candidate,
      manifest: "m",
      sealed: {},
      complete: true,
    }),
    undefined,
  );
  assert.equal(forwardHeadCandidate(undefined), undefined);
});

test("each abandoned-before-forward source guard refuses on its own", async (context) => {
  const { f } = await stoppedBeforeForward(context);
  const image = await Effect.runPromise(f.state.getOutput(releaseImageJournalKey(f.scope)));
  const forward = (await Effect.runPromise(f.state.getOutput(journalKey(f.scope)))) as {
    candidate: string;
    manifest: string;
    sealed: unknown;
  };
  const { record } = decodeRuntimeReleaseHead(image, f.key);
  const packet = readForwardPacket(
    openRecovery(forward.sealed, f.key, forward.candidate, forward.manifest),
  );
  const check = (
    changedRecord: RuntimeReleaseRecord,
    changedPacket: ForwardPacket = packet,
    head = { candidate: forward.candidate },
  ) =>
    settlementSourceFailure(
      "abandoned-before-forward",
      f.candidate,
      changedRecord,
      head,
      changedPacket,
    );
  assert.equal(check(record), undefined);
  const receipt = packet.receipt;
  const withReceipt = (change: Partial<ForwardPacket["receipt"]>) => ({
    ...packet,
    receipt: { ...receipt, ...change },
  });
  const cases: [string, RuntimeReleaseRecord, ForwardPacket?, { candidate: string }?][] = [
    ["record.candidate", { ...record, candidate: next }],
    ["record.complete", { ...record, complete: true }],
    ["record.abort", { ...record, abort: {} as never }],
    ["record.update", { ...record, update: {} as never }],
    ["record.promotion", { ...record, promotion: {} as never }],
    ["record.bootstrap", { ...record, bootstrap: { blue: {} as never } }],
    ["record.configurations", { ...record, configurations: { blue: {} as never } }],
    [
      "record.baselineController",
      {
        ...record,
        baselineController: {
          ...record.baselineController!,
          code: { ...record.baselineController!.code, candidate: f.candidate },
        },
      },
    ],
    ["forward.candidate", record, packet, { candidate: f.candidate }],
    [
      "forward.manifest.candidate",
      record,
      { ...packet, manifest: { ...packet.manifest, candidate: f.candidate } },
    ],
    [
      "forward.frozen.container",
      record,
      { ...packet, frozen: { ...packet.frozen, containers: [] } },
    ],
    [
      "forward.manifest.workers",
      record,
      {
        ...packet,
        manifest: {
          ...packet.manifest,
          workers: Array.from({ length: 33 }, () => packet.manifest.workers[0]!),
        },
      },
    ],
    ["receipt.phase", record, withReceipt({ phase: "upload" })],
    ["receipt.pending", record, withReceipt({ pending: {} as never })],
    ["receipt.pendingUpload", record, withReceipt({ pendingUpload: { worker: "Api" } })],
    ["receipt.pendingContainer", record, withReceipt({ pendingContainer: {} as never })],
    ["receipt.accepted", record, withReceipt({ accepted: receipt.accepted.slice(1) })],
    ["receipt.activated", record, withReceipt({ activated: receipt.activated.slice(1) })],
    [
      "receipt.containers",
      record,
      withReceipt({
        containers: [{ container: "Other", unchanged: true } as never],
      }),
    ],
  ];
  for (const [guard, changedRecord, changedPacket, head] of cases)
    assert.equal(check(changedRecord, changedPacket, head), guard, guard);
});
