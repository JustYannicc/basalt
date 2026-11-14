import assert from "node:assert/strict";
import { test } from "node:test";
import { Schema } from "effect";
import { handoffWorker } from "../../scripts/pool-tests/runtime-handoff-worker.ts";
import { type SlotSelection } from "./runtime-slots/contract.ts";
import { UnattestedActive, launchWitnessKey } from "./runtime-slots/admission-proof.ts";
import { slotSelectionKey } from "./runtime-slots/storage.ts";
import { decodeUnattestedAdoptionResponse } from "./runtime-slots/adoption-readback.ts";
import type { WitnessRecord } from "./runtime-slots/witness-store.ts";

const authorization = (f: Awaited<ReturnType<typeof handoffWorker>>) =>
  Schema.decodeUnknownSync(UnattestedActive)(f.preservation.proof);
async function witness(f: Awaited<ReturnType<typeof handoffWorker>>) {
  return f.command("witness", { target: f.old.target });
}

test("adopt ACK and later legacy readback bind the actual retained operation, capsule, boot and committed selection", async (context) => {
  const f = await handoffWorker();
  context.after(f.cleanup);
  const expected = authorization(f),
    ack = decodeUnattestedAdoptionResponse(f.adoptionAck, expected);
  assert.equal(ack.operationId, expected.operationId);
  assert.equal(ack.manifestDigest, expected.manifestDigest);
  assert.deepEqual(ack.identity, { ...expected.target, bootId: expected.bootId });
  assert.equal(ack.configurationFingerprint, expected.configurationFingerprint);
  assert.equal(ack.selection.expectedEpoch, expected.selection.expectedEpoch + 1);
  assert.equal(ack.selection.policyDigest, expected.selection.policyDigest);
  assert.deepEqual(ack.selection.revisions, expected.selection.revisions);
  assert.deepEqual(ack.selection.active, ack.identity);
  let writes = 0;
  f.old.storage.afterCommit = (keys) => {
    writes += keys.length;
  };
  const before = f.old.calls.keepAlive;
  f.reconstruct();
  const read = await witness(f);
  assert.equal(read.status, 200, await read.clone().text());
  assert.deepEqual(decodeUnattestedAdoptionResponse(await read.json(), expected), ack);
  assert.equal(writes, 0);
  assert.equal(f.old.calls.keepAlive, before);
  assert.equal(f.old.calls.start, 0);
  assert.equal(f.old.calls.destroy, 0);
});

test("a retained capsule without committed controller adoption cannot produce an adoption readback", async (context) => {
  const f = await handoffWorker({ adopt: false });
  context.after(f.cleanup);
  await f.old.endpoint.admit(f.preservation.envelope);
  assert.equal((await witness(f)).status, 409);
  assert.equal(await f.old.storage.get(slotSelectionKey), undefined);
  assert.equal(f.old.calls.start, 0);
});

for (const change of ["boot", "stopped"] as const)
  test(`legacy adoption readback refuses a ${change} runtime instead of trusting only retained identity`, async (context) => {
    const f = await handoffWorker();
    context.after(f.cleanup);
    if (change === "boot") f.old.replaceBoot();
    else f.old.crash();
    assert.equal((await witness(f)).status, 409);
    assert.equal(f.old.calls.start, 0);
    assert.equal(f.old.calls.destroy, 0);
  });

test("an existing candidate prevents the first-adoption readback gate from being reused", async (context) => {
  const f = await handoffWorker();
  context.after(f.cleanup);
  const grant = await f.startGrant();
  assert.equal((await f.stage(grant.envelope)).status, 200);
  assert.equal((await witness(f)).status, 409);
});

test("a different retained controller epoch cannot ACK the original adoption", async (context) => {
  const f = await handoffWorker();
  context.after(f.cleanup);
  const selection = await f.old.storage.get<SlotSelection>(slotSelectionKey);
  assert.ok(selection);
  await f.old.storage.put(slotSelectionKey, { ...selection, epoch: selection.epoch + 1 });
  assert.equal((await witness(f)).status, 409);
});

test("selection drift while authenticated health is awaited refuses the readback", async (context) => {
  const f = await handoffWorker();
  context.after(f.cleanup);
  let changed = false;
  f.old.hooks.health = async () => {
    if (changed) return;
    changed = true;
    const selection = await f.old.storage.get<SlotSelection>(slotSelectionKey);
    assert.ok(selection);
    await f.old.storage.put(slotSelectionKey, { ...selection, epoch: selection.epoch + 1 });
  };
  assert.equal((await witness(f)).status, 409);
  assert.equal(changed, true);
});

test("an absent preserved capsule prevents a retained selection from impersonating adoption", async (context) => {
  const f = await handoffWorker();
  context.after(f.cleanup);
  await f.old.storage.delete(launchWitnessKey(f.old.target.slotId));
  assert.equal((await witness(f)).status, 409);
});

test("lost adoption commit acknowledgement leaves inspectable state without a repeated adoption write", async (context) => {
  const f = await handoffWorker({ adopt: false });
  context.after(f.cleanup);
  let selectionWrites = 0;
  f.old.storage.afterCommit = (keys) => {
    if (!keys.includes(slotSelectionKey)) return;
    selectionWrites++;
    if (selectionWrites === 1) throw new Error("lost adoption selection acknowledgement");
  };
  const adopt = await f.command("adopt", { proof: f.preservation.envelope });
  assert.equal(adopt.status, 500);
  assert.equal(selectionWrites, 1);
  f.reconstruct();
  const observed = await witness(f);
  assert.equal(observed.status, 200, await observed.clone().text());
  assert.equal(
    decodeUnattestedAdoptionResponse(await observed.json(), authorization(f)).operationId,
    authorization(f).operationId,
  );
  assert.equal((await f.command("adopt", { proof: f.preservation.envelope })).status, 409);
  assert.equal(selectionWrites, 1);
  assert.equal(f.old.calls.start, 0);
  assert.equal(f.old.calls.destroy, 0);
});

for (const state of ["fenced", "retiring", "draining"] as const)
  test(`an active ${state} state cannot pass the first-adoption gate`, async (context) => {
    const f = await handoffWorker();
    context.after(f.cleanup);
    const selection = await f.old.storage.get<SlotSelection>(slotSelectionKey);
    assert.ok(selection);
    const next =
      state === "fenced"
        ? { ...selection, active: { ...selection.active, fenced: true } }
        : state === "retiring"
          ? {
              ...selection,
              active: {
                ...selection.active,
                retirement: { operationId: crypto.randomUUID(), status: "started" as const },
              },
            }
          : { ...selection, draining: selection.active };
    await f.old.storage.put(slotSelectionKey, next);
    assert.equal((await witness(f)).status, state === "draining" ? 500 : 409);
  });

for (const corruption of ["fingerprint", "ciphertext"] as const)
  test(`a preserved capsule with changed ${corruption} cannot ACK adoption`, async (context) => {
    const f = await handoffWorker();
    context.after(f.cleanup);
    const key = launchWitnessKey(f.old.target.slotId),
      record = await f.old.storage.get<WitnessRecord>(key);
    assert.ok(record);
    const ciphertext = Buffer.from(record.sealed.ciphertext, "hex");
    ciphertext[0] = ciphertext[0]! ^ 1;
    const next =
      corruption === "fingerprint"
        ? {
            ...record,
            authorization: { ...record.authorization, configurationFingerprint: "f".repeat(64) },
          }
        : {
            ...record,
            sealed: {
              ...record.sealed,
              ciphertext: ciphertext.toString("hex"),
            },
          };
    if (corruption === "ciphertext")
      assert.notDeepEqual(
        Buffer.from(next.sealed.ciphertext, "hex"),
        Buffer.from(record.sealed.ciphertext, "hex"),
      );
    await f.old.storage.put(key, next);
    assert.equal((await witness(f)).status, corruption === "ciphertext" ? 500 : 409);
  });

test("a changed whole membership revision refuses a previously valid adoption readback", async (context) => {
  const f = await handoffWorker();
  context.after(f.cleanup);
  assert.equal((await f.reserve()).status, 204);
  assert.equal((await witness(f)).status, 409);
});

test("the consumer fences a different retained operation rather than accepting a reconstructed caller echo", async (context) => {
  const f = await handoffWorker();
  context.after(f.cleanup);
  const key = launchWitnessKey(f.old.target.slotId),
    record = await f.old.storage.get<WitnessRecord>(key);
  assert.ok(record);
  await f.old.storage.put(key, {
    ...record,
    authorization: { ...record.authorization, operationId: "different-retained-operation" },
  });
  const response = await witness(f);
  assert.equal(response.status, 200);
  const value: unknown = await response.json();
  assert.throws(() => decodeUnattestedAdoptionResponse(value, authorization(f)), /operationId/);
});
