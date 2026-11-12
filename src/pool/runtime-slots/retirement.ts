import { Schema } from "effect";
import {
  RetirementReceipt,
  SlotRefused,
  sameIdentity,
  sameTarget,
  executionKey,
  type SlotDriver,
} from "./contract.ts";
import type { SlotClock } from "./proof.ts";
import { RuntimeSlotStorage, slotSelectionKey, slotStoragePrefix } from "./storage.ts";
import { SlotStreams } from "./streams.ts";

/** A started retirement survives a lost reply and cannot repeat destruction. */
export class SlotRetirement {
  private storage: RuntimeSlotStorage;
  private driver: SlotDriver;
  private streams: SlotStreams;
  private clock: SlotClock;
  constructor(
    storage: RuntimeSlotStorage,
    driver: SlotDriver,
    streams: SlotStreams,
    clock: SlotClock,
  ) {
    this.storage = storage;
    this.driver = driver;
    this.streams = streams;
    this.clock = clock;
  }
  private key(operationId: string) {
    this.storage.receiptKey(operationId);
    return `${slotStoragePrefix}retirement:${operationId}`;
  }
  inspect(operationId: string) {
    return this.storage.transact(async (_, transaction) => {
      const value = await transaction.get(this.key(operationId));
      return value === undefined ? undefined : Schema.decodeUnknownSync(RetirementReceipt)(value);
    });
  }
  async run(role: "candidate" | "draining", operationId: string) {
    const key = this.key(operationId);
    const pending = await this.storage.transact(async ({ selection }, transaction) => {
      const previous = await transaction.get(key);
      if (previous !== undefined)
        return { receipt: Schema.decodeUnknownSync(RetirementReceipt)(previous) };
      const slot = selection?.[role];
      if (!slot?.identity || slot.retirement) throw new SlotRefused("uncertain");
      if (role === "draining" && this.streams.active(executionKey(slot.identity)))
        throw new SlotRefused("draining");
      return { slot };
    });
    if (pending.receipt) return pending.receipt;
    const drained = await this.driver.drain(pending.slot!.identity!, AbortSignal.timeout(2_000));
    if (!drained.known || drained.active !== 0) throw new SlotRefused("draining");
    const started = await this.storage.transact(async ({ selection }, transaction) => {
      const previous = await transaction.get(key);
      if (previous !== undefined)
        return { receipt: Schema.decodeUnknownSync(RetirementReceipt)(previous) };
      const slot = selection?.[role];
      if (!selection || !slot) throw new SlotRefused("selection");
      if (!sameIdentity(slot.identity, pending.slot!.identity!)) throw new SlotRefused("identity");
      // Unknown startup cannot be destroyed by guessing a boot. Keep it visibly pending.
      if (!slot.identity || slot.retirement) throw new SlotRefused("uncertain");
      if (role === "draining" && this.streams.active(executionKey(slot.identity)))
        throw new SlotRefused("draining");
      const receipt: RetirementReceipt = {
        operationId,
        target: slot.target,
        identity: slot.identity,
        status: "started",
        at: this.clock.now(),
      };
      await transaction.put(slotSelectionKey, {
        ...selection,
        [role]: { ...slot, fenced: true, retirement: { operationId, status: "started" } },
      });
      await transaction.put(key, receipt);
      return { receipt, slot };
    });
    if (!started.slot) return started.receipt;
    this.streams.abortSlot(executionKey(started.slot.identity!));
    await this.driver.retire(
      started.slot.target,
      started.slot.identity!,
      AbortSignal.timeout(2_000),
    );
    return this.storage.transact(async ({ selection }, transaction) => {
      const current = selection?.[role];
      if (
        !selection ||
        !current ||
        !sameTarget(current.target, started.slot.target) ||
        !sameIdentity(current.identity, started.slot.identity!) ||
        current.retirement?.operationId !== operationId
      )
        throw new SlotRefused("identity");
      const next = { ...selection };
      delete next[role];
      const receipt: RetirementReceipt = { ...started.receipt, status: "retired" };
      await transaction.put(slotSelectionKey, next);
      await transaction.put(key, receipt);
      return receipt;
    });
  }
}
