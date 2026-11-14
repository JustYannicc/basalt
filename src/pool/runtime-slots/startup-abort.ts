import { Schema } from "effect";
import { SlotRefused, sameIdentity, sameTarget } from "./contract.ts";
import { StartupWitness } from "./admission-proof.ts";
import { slotSelectionKey, type RuntimeSlotStorage, type SlotStorage } from "./storage.ts";
import type { BoundSlotDriver } from "./transport.ts";
import {
  StartupAbortIntent,
  StartupAbortReceipt,
  type StartupStopRecord,
  startupAbortKey,
  sameStartupWitness,
} from "./startup-abort-contract.ts";

/** Abort proves the old boot is still selected, fences promotion, and sends at most one exact stop. */
export class RuntimeStartupAbort {
  private slots: RuntimeSlotStorage;
  private storage: SlotStorage;
  private driver: BoundSlotDriver;
  private absent?: (record: StartupStopRecord) => Promise<void>;
  constructor(
    slots: RuntimeSlotStorage,
    storage: SlotStorage,
    driver: BoundSlotDriver,
    absent?: (record: StartupStopRecord) => Promise<void>,
  ) {
    this.slots = slots;
    this.storage = storage;
    this.driver = driver;
    this.absent = absent;
  }
  private async read(operationId: string, storage = this.storage) {
    const raw = await storage.get(startupAbortKey(operationId));
    return raw === undefined ? undefined : Schema.decodeUnknownSync(StartupAbortReceipt)(raw);
  }
  async abort(value: StartupAbortIntent) {
    const intent = Schema.decodeUnknownSync(StartupAbortIntent)(value);
    const previous = await this.read(intent.operationId);
    if (previous) {
      if (JSON.stringify(previous.intent) !== JSON.stringify(intent))
        throw new SlotRefused("identity");
      return this.inspect(intent.operationId);
    }
    const health = await this.driver.health(intent.active, AbortSignal.timeout(2_000));
    const witness = Schema.decodeUnknownSync(
      Schema.Struct({ witness: Schema.optional(StartupWitness) }),
    )(await this.driver.witness(intent.target));
    if (!sameStartupWitness(intent.witness, witness.witness)) throw new SlotRefused("identity");
    const receipt: StartupAbortReceipt = { intent, status: "pending", sent: true };
    await this.slots.transact(async ({ selection }, transaction) => {
      if (
        !selection?.candidate ||
        selection.epoch !== intent.expectedEpoch ||
        !sameIdentity(selection.active.identity, intent.active) ||
        selection.active.fenced ||
        selection.active.retirement ||
        selection.draining ||
        selection.candidate.retirement ||
        selection.candidate.fenced ||
        !sameTarget(selection.candidate.target, intent.target) ||
        !sameIdentity(health.identity, intent.active) ||
        health.policyLeaseUntil <= performance.now() ||
        (await transaction.get(startupAbortKey(intent.operationId)))
      )
        throw new SlotRefused("selection");
      await transaction.put(slotSelectionKey, {
        ...selection,
        candidate: { ...selection.candidate, fenced: true },
      });
      await transaction.put(startupAbortKey(intent.operationId), receipt);
    });
    const { expectedEpoch: _epoch, active: _active, ...stop } = intent;
    try {
      const observation = await this.driver.abortStartup(stop, false);
      if (observation.status === "aborted") return await this.complete(receipt, observation);
    } catch {
      // An unknown stop is recovered by inspection, never another destruction command.
    }
    return receipt;
  }
  private async complete(receipt: StartupAbortReceipt, stopped: StartupStopRecord) {
    await this.absent?.(stopped);
    const { intent } = receipt;
    const health = await this.driver.health(intent.active, AbortSignal.timeout(2_000));
    return this.slots.transact(async ({ selection }, transaction) => {
      const current = await this.read(intent.operationId, transaction);
      if (current?.status === "aborted") return current;
      if (
        !selection?.candidate ||
        selection.epoch !== intent.expectedEpoch ||
        !sameIdentity(selection.active.identity, intent.active) ||
        selection.active.fenced ||
        selection.active.retirement ||
        !selection.candidate.fenced ||
        !sameTarget(selection.candidate.target, intent.target) ||
        !sameIdentity(health.identity, intent.active) ||
        health.policyLeaseUntil <= performance.now()
      )
        throw new SlotRefused("selection");
      const next: StartupAbortReceipt = { ...receipt, status: "aborted" };
      await transaction.put(slotSelectionKey, { ...selection, candidate: undefined });
      await transaction.put(startupAbortKey(intent.operationId), next);
      return next;
    });
  }
  async inspect(operationId: string) {
    const receipt = await this.read(operationId);
    if (!receipt) throw new SlotRefused("selection");
    if (receipt.status === "aborted") return receipt;
    const { expectedEpoch: _epoch, active: _active, ...stop } = receipt.intent;
    try {
      const observed = await this.driver.abortStartup(stop, true);
      if (observed.status === "aborted") return await this.complete(receipt, observed);
    } catch {}
    return receipt;
  }
}
