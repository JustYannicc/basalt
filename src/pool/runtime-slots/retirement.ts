import { Schema } from "effect";
import {
  RetirementReceipt,
  SlotRefused,
  sameIdentity,
  sameTarget,
  executionKey,
  type SlotDriver,
  type SlotIdentity,
  type RuntimeRetirementObservation,
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
  private provider?: RetirementProvider;
  constructor(
    storage: RuntimeSlotStorage,
    driver: SlotDriver,
    streams: SlotStreams,
    clock: SlotClock,
    provider?: RetirementProvider,
  ) {
    this.storage = storage;
    this.driver = driver;
    this.streams = streams;
    this.clock = clock;
    this.provider = provider;
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
      if (previous !== undefined) {
        const receipt = Schema.decodeUnknownSync(RetirementReceipt)(previous);
        if (receipt.status === "retired") return { receipt };
        const slot = selection?.[role];
        if (
          !slot?.identity ||
          !sameIdentity(slot.identity, receipt.identity!) ||
          slot.retirement?.operationId !== operationId
        )
          throw new SlotRefused("identity");
        return { receipt, slot };
      }
      const slot = selection?.[role];
      if (!slot?.identity || slot.retirement) throw new SlotRefused("uncertain");
      if (role === "draining" && this.streams.active(executionKey(slot.identity)))
        throw new SlotRefused("draining");
      return { slot };
    });
    if (pending.receipt?.status === "retired") return pending.receipt;
    if (pending.receipt) return this.recover(role, pending.receipt);
    const drained = await this.driver.drain(pending.slot!.identity!, AbortSignal.timeout(2_000));
    if (!drained.known || drained.active !== 0) throw new SlotRefused("draining");
    const observation = await this.driver.retirement(
      pending.slot!.identity!,
      AbortSignal.timeout(2_000),
    );
    if (
      !sameIdentity(observation.identity, pending.slot!.identity!) ||
      (!observation.retireNotStarted && !(observation.retired && !observation.running))
    )
      throw new SlotRefused("uncertain");
    if (!observation.retired) await this.provider?.("present", observation);
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
    if (!started.slot) return this.recover(role, started.receipt);
    this.streams.abortSlot(executionKey(started.slot.identity!));
    if (!observation.retired)
      await this.driver.retire(
        started.slot.target,
        started.slot.identity!,
        AbortSignal.timeout(2_000),
      );
    return this.recover(role, started.receipt);
  }
  private async recover(role: "candidate" | "draining", receipt: RetirementReceipt) {
    const identity = receipt.identity;
    if (!identity) throw new SlotRefused("identity");
    if (this.streams.active(executionKey(identity))) throw new SlotRefused("draining");
    let observed = await this.driver.retirement(identity, AbortSignal.timeout(2_000));
    if (!sameIdentity(observed.identity, identity)) throw new SlotRefused("identity");
    if (!observed.retired && observed.retireNotStarted) {
      const drain = await this.driver.drain(identity, AbortSignal.timeout(2_000));
      if (!drain.known || drain.active !== 0) throw new SlotRefused("draining");
      await this.provider?.("present", observed);
      // The endpoint proves its destruction intent was never recorded. Its retiring latch serializes reissue.
      await this.driver.retire(receipt.target, identity, AbortSignal.timeout(2_000));
      observed = await this.driver.retirement(identity, AbortSignal.timeout(2_000));
    }
    if (!sameIdentity(observed.identity, identity) || !observed.retired || observed.running)
      throw new SlotRefused("uncertain");
    await this.provider?.("absent", observed);
    return this.storage.transact(async ({ selection }, transaction) => {
      const prior = await transaction.get(this.key(receipt.operationId));
      if (prior && Schema.decodeUnknownSync(RetirementReceipt)(prior).status === "retired")
        return Schema.decodeUnknownSync(RetirementReceipt)(prior);
      const current = selection?.[role];
      if (
        !selection ||
        !current ||
        !sameTarget(current.target, receipt.target) ||
        !sameIdentity(current.identity, identity) ||
        current.retirement?.operationId !== receipt.operationId
      )
        throw new SlotRefused("identity");
      const next = { ...selection };
      delete next[role];
      const retired: RetirementReceipt = { ...receipt, status: "retired" };
      await transaction.put(slotSelectionKey, next);
      await transaction.put(this.key(receipt.operationId), retired);
      return retired;
    });
  }
}

export type RetirementProvider = (
  phase: "present" | "absent",
  observation: RuntimeRetirementObservation & { identity: SlotIdentity },
) => Promise<void>;
