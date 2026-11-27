import assert from "node:assert/strict";
import { test } from "node:test";
import { SlotMemory } from "../../scripts/pool-tests/runtime-slot-storage.ts";
import { SlotRefused, type SlotIdentity } from "./runtime-slots/contract.ts";
import { lastRecovery, RecoveryRecords } from "./runtime-slots/recovery-record.ts";
import { ProviderObservationRefused } from "./runtime-provider/read.ts";
import { RuntimeSlotStorage } from "./runtime-slots/storage.ts";

const boot = (bootId: string): SlotIdentity => ({
  format: "pool-runtime-slot-v1",
  controllerId: "controller",
  slotId: "primary",
  applicationId: "application",
  applicationVersion: "1",
  instanceId: "instance",
  imageDigest: `sha256:${"a".repeat(64)}`,
  imageInput: "b".repeat(64),
  bootId,
});

test("one recovery counts its rounds and their refusals until the root serves, then the next starts over", async () => {
  const memory = new SlotMemory();
  const records = new RecoveryRecords(new RuntimeSlotStorage(memory));
  assert.equal(await records.round(boot("first"), 1_000), 1);
  await records.refused(1, 1_500, new SlotRefused("identity"));
  assert.equal(await records.round(boot("first"), 3_000), 2);
  await records.ready(4_000);
  assert.deepEqual(await lastRecovery(memory), {
    boot: "first",
    detectedAt: 1_000,
    readyAt: 4_000,
    rounds: 2,
    refusals: [{ round: 1, at: 1_500, reason: "slot_identity", class: "SlotRefused" }],
  });
  // A served root's next recovery is a new one, for the same boot or the next.
  assert.equal(await records.round(boot("second"), 9_000), 1);
  assert.deepEqual(await lastRecovery(memory), {
    boot: "second",
    detectedAt: 9_000,
    readyAt: null,
    rounds: 1,
    refusals: [],
  });
});

test("a recovery that keeps refusing keeps only its latest rounds' refusals", async () => {
  const memory = new SlotMemory();
  const records = new RecoveryRecords(new RuntimeSlotStorage(memory));
  for (let round = 1; round <= 12; round++) {
    await records.round(boot("first"), round * 1_000);
    await records.refused(round, round * 1_000 + 1, new Error("refused"));
  }
  const record = await lastRecovery(memory);
  assert.equal(record?.rounds, 12);
  assert.deepEqual(
    record?.refusals.map((refusal) => refusal.round),
    [5, 6, 7, 8, 9, 10, 11, 12],
  );
});

test("healthy passes read the record once, and write only to end an open recovery", async () => {
  const memory = new SlotMemory();
  const storage = new RuntimeSlotStorage(memory);
  let transactions = 0;
  const plain = storage.plain.bind(storage);
  storage.plain = (work) => {
    transactions++;
    return plain(work);
  };
  const records = new RecoveryRecords(storage);
  for (let pass = 0; pass < 5; pass++) await records.ready(pass);
  assert.equal(transactions, 1);
  assert.equal(await lastRecovery(memory), null);
  await records.round(boot("first"), 10);
  await records.ready(20);
  await records.ready(30);
  assert.equal((await lastRecovery(memory))?.readyAt, 20);
});

test("a provider refusal's round keeps its read and its own reason, with the status or pin behind it", async () => {
  const memory = new SlotMemory();
  const records = new RecoveryRecords(new RuntimeSlotStorage(memory));
  await records.round(boot("first"), 1_000);
  // As the recovery's observe names its read on the way out.
  const limited = new ProviderObservationRefused({ reason: "read_status", status: 429 });
  limited.read = "recovery";
  await records.refused(1, 1_100, limited);
  const image = new ProviderObservationRefused({ reason: "mismatch", field: "image" });
  image.read = "recovery";
  await records.refused(1, 1_200, image);
  const provider = {
    class: "ProviderObservationRefused",
    provider: "provider_observation_refused",
    read: "recovery",
  };
  assert.deepEqual((await lastRecovery(memory))?.refusals, [
    { round: 1, at: 1_100, reason: "read_status", ...provider, status: 429 },
    { round: 1, at: 1_200, reason: "mismatch", ...provider, field: "image" },
  ]);
});

test("a record an older Worker wrote for a sibling's refusal still reads with that sibling's state", async () => {
  const memory = new SlotMemory();
  const older = {
    boot: "first",
    detectedAt: 1_000,
    readyAt: null,
    rounds: 1,
    refusals: [
      {
        round: 1,
        at: 1_200,
        reason: "sibling_unsettled",
        class: "ProviderObservationRefused",
        provider: "provider_observation_refused",
        read: "recovery",
        state: "stopping",
      },
    ],
  };
  await memory.put("runtime-slots-v1:last-recovery", older);
  assert.deepEqual(await lastRecovery(memory), older);
});
