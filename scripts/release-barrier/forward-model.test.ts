import assert from "node:assert/strict";
import { test } from "node:test";
import { Effect, Redacted } from "effect";
import { State, type PersistedState } from "alchemy/State/State";
import { InMemoryService } from "alchemy/State/InMemoryState";
import { encodeState } from "alchemy/State/StateEncoding";
import {
  encodedRecordHash,
  forwardAdoption,
  readForwardPacket,
  verifyForwardWorkers,
} from "./forward-model.ts";
import { beginForwardJournal, readForwardJournal } from "./forward-journal.ts";
import { undoForwardRecord } from "./forward-write.ts";
import { readOnlyProbeFetch } from "./probe-network.ts";
import { containerRelease } from "./test/container-fixture.ts";
import { releaseWorkers, type BarrierReceipt } from "./barrier.ts";
import { describeContainer } from "./container.ts";
import { describeWorker } from "./manifest.ts";

const encryptionKey = "f".repeat(64);
async function fixture() {
  const f = containerRelease();
  await releaseWorkers(f.manifest, {
    provider: f.options.provider,
    containers: {
      ...f.options.containers,
      verify: async () => {
        throw new Error("Synthetic serving failure");
      },
    },
    record: async (value) => {
      f.receipts.push(value);
    },
  }).catch(() => {});
  const saved: PersistedState = {
    resourceType: "Cloudflare.Container",
    namespace: undefined,
    fqn: "PoolContainer",
    logicalId: "PoolContainer",
    instanceId: "instance",
    providerVersion: 1,
    status: "updated",
    downstream: ["PoolWorker"],
    bindings: [],
    props: { secret: Redacted.make("synthetic-secret") },
    attr: f.previous,
  };
  const manifest = {
    ...f.manifest,
    workers: f.manifest.workers.map(describeWorker),
    containers: f.manifest.containers!.map(describeContainer),
  };
  const packet = readForwardPacket({
    schemaVersion: 1,
    manifest,
    frozen: { ...manifest, containers: f.manifest.containers },
    receipt: f.receipts.at(-1),
    nativeBefore: encodeState(saved),
  });
  return { ...f, saved, packet, observed: { ...f.proposed, version: 2 } };
}

test("forward guard adopts only verified attrs and hash, preserving exact metadata and secrets", async () => {
  const f = await fixture();
  const result = forwardAdoption(f.packet, f.saved, f.observed);
  assert.equal(result.receipt.disposition, "adopt-candidate");
  assert.equal(result.after.props, f.saved.props);
  assert.equal(result.after.bindings, f.saved.bindings);
  assert.equal(result.after.instanceId, f.saved.instanceId);
  assert.equal(result.after.attr?.hash.image, f.frozen.inputHash);
  assert.notEqual(result.receipt.before, result.receipt.after);
  assert.throws(
    () => forwardAdoption(f.packet, { ...f.saved, downstream: [] }, f.observed),
    /forward-native-before-drift/u,
  );
  assert.throws(
    () => forwardAdoption(f.packet, f.saved, { ...f.observed, maxInstances: 2 }),
    /forward-container-drift/u,
  );
  assert.throws(
    () => forwardAdoption(f.packet, result.after, f.observed),
    /forward-native-after-drift/u,
  );
  const withIntent = {
    ...f.packet,
    adoption: { before: result.receipt.before, after: result.receipt.after, backup: {} },
  };
  assert.equal(
    forwardAdoption(withIntent, result.after, f.observed).receipt.disposition,
    "already-adopted",
  );
});

test("uncertain rollout and unrelated Worker versions refuse before adoption", async () => {
  const f = await fixture();
  assert.throws(
    () =>
      forwardAdoption(
        {
          ...f.packet,
          receipt: {
            ...f.packet.receipt,
            pendingContainer: { container: "PoolContainer", phase: "rollout" },
          },
        },
        f.saved,
        f.observed,
      ),
    /forward-rollout-unconfirmed/u,
  );
  const live = new Map(
    f.packet.manifest.workers.map((worker) => [
      worker.id,
      { target: worker.target, versions: [...worker.baseline] },
    ]),
  );
  verifyForwardWorkers(f.packet, live);
  live.set("PoolWorker", {
    ...live.get("PoolWorker")!,
    versions: [{ versionId: "unrelated", percentage: 100 }],
  });
  assert.throws(() => verifyForwardWorkers(f.packet, live), /forward-worker-drift/u);
});

test("undo requires the exact after hash, restores encoded secrets and refuses later edits", async () => {
  const f = await fixture();
  const result = forwardAdoption(f.packet, f.saved, f.observed);
  const backup = {
    schemaVersion: 1,
    before: encodeState(f.saved),
    after: encodeState(result.after),
    receipt: result.receipt,
  };
  let current: PersistedState = result.after;
  let writes = 0;
  const io = {
    read: async () => current,
    write: async (value: PersistedState) => {
      current = value;
      writes++;
    },
  };
  await undoForwardRecord(backup, io);
  assert.equal(encodedRecordHash(current), result.receipt.before);
  assert.ok(Redacted.isRedacted(current.props?.secret));
  await undoForwardRecord(backup, io);
  assert.equal(writes, 1);
  current = { ...result.after, downstream: [] };
  await assert.rejects(undoForwardRecord(backup, io), /forward-undo-current-drift/u);
  assert.equal(writes, 1);
});

test("journal durably retains frozen state and every uncertain activation before acknowledgment", async () => {
  const f = await fixture();
  await Effect.runPromise(
    Effect.gen(function* () {
      const state = yield* InMemoryService();
      const stack = { name: "basalt", stage: "production" };
      yield* state.set({ ...stack, stack: stack.name, fqn: "PoolContainer", value: f.saved });
      const journal = yield* beginForwardJournal(stack, f.manifest, encryptionKey).pipe(
        Effect.provideService(State, Effect.succeed(state)),
      );
      assert.ok(journal);
      const receipt: BarrierReceipt = f.receipts.at(-1)!;
      yield* journal.record(receipt);
      const stored = yield* state.getOutput({
        stack: "basalt-release-barrier",
        stage: "production",
      });
      assert.ok(stored);
      assert.doesNotMatch(JSON.stringify(stored), /synthetic-secret|registry.cloudflare/u);
      const read = yield* readForwardJournal(stack, encryptionKey).pipe(
        Effect.provideService(State, Effect.succeed(state)),
      );
      assert.ok(read && !read.complete);
      assert.deepEqual(read.packet.receipt.pendingContainer, receipt.pendingContainer);
      assert.deepEqual(read.packet.receipt.activated, receipt.activated);
      assert.deepEqual(read.packet.receipt.failure, receipt.failure);
      assert.equal(encodedRecordHash(read.packet.nativeBefore), encodedRecordHash(f.saved));
      const adopted = forwardAdoption(read.packet, f.saved, f.observed);
      yield* journal.finalizingState.set({
        stack: stack.name,
        stage: stack.stage,
        fqn: "PoolContainer",
        value: adopted.after,
      });
      const finalizing = yield* readForwardJournal(stack, encryptionKey).pipe(
        Effect.provideService(State, Effect.succeed(state)),
      );
      assert.ok(finalizing && !finalizing.complete);
      assert.equal(
        forwardAdoption(finalizing.packet, adopted.after, f.observed).receipt.disposition,
        "already-adopted",
      );
      const prior = finalizing.packet.adoption!;
      assert.equal(prior.before, adopted.receipt.before);
      assert.equal(prior.after, adopted.receipt.after);
    }),
  );
});

test("probe refuses State writes, production uploads and signed readiness POSTs", async () => {
  const sent: string[] = [];
  const guarded = readOnlyProbeFetch("fixture", async (input) => {
    sent.push(String(input));
    return new Response();
  });
  for (const url of [
    "https://state.invalid/state/stacks/basalt",
    "https://api.cloudflare.com/client/v4/accounts/fixture/workers/scripts/PoolWorker",
    "https://private.invalid/deployment-readiness",
  ])
    await assert.rejects(guarded(url, { method: "POST" }), /forward-probe-mutation-refused/u);
  assert.equal(sent.length, 0);
  await guarded(
    "https://api.cloudflare.com/client/v4/accounts/fixture/workers/scripts/alchemy-state-store/edge-preview",
    { method: "POST" },
  );
  assert.equal(sent.length, 1);
});
