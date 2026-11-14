import { Schema } from "effect";
import { SlotIdentity, SlotTarget, SlotRefused, sameTarget } from "./contract.ts";
import type { StartAuthorization } from "./admission-proof.ts";
import type { RuntimeSlots } from "./controller.ts";
import type { RuntimeSlotStorage, SlotStorage } from "./storage.ts";

export const RuntimeStageRecord = Schema.Struct({
  operationId: Schema.NonEmptyString,
  target: SlotTarget,
  deadline: Schema.Number,
  status: Schema.Literals(["starting", "ready", "failed"]),
  identity: Schema.optional(SlotIdentity),
  readyAt: Schema.optional(Schema.Number),
});
export type RuntimeStageRecord = typeof RuntimeStageRecord.Type;
const key = (target: SlotTarget) => `runtime-slots-v1:startup:${target.slotId}`;

/** Startup outlives a bridge request. Recovery observes the same launch and never starts it again. */
export class RuntimeStaging {
  private pending = new Set<string>();
  private slots: RuntimeSlots;
  private storage: RuntimeSlotStorage;
  private readStorage: SlotStorage;
  private defer: (work: Promise<unknown>) => void;
  private now: () => number;
  constructor(
    slots: RuntimeSlots,
    storage: RuntimeSlotStorage,
    readStorage: SlotStorage,
    defer: (work: Promise<unknown>) => void,
    now = Date.now,
  ) {
    this.slots = slots;
    this.storage = storage;
    this.readStorage = readStorage;
    this.defer = defer;
    this.now = now;
  }
  private async read(target: SlotTarget, storage = this.readStorage) {
    const raw = await storage.get(key(target));
    if (raw === undefined) throw new SlotRefused("selection");
    const record = Schema.decodeUnknownSync(RuntimeStageRecord)(raw);
    if (!sameTarget(record.target, target)) throw new SlotRefused("identity");
    return record;
  }
  private async finish(record: RuntimeStageRecord, identity?: SlotIdentity) {
    return this.storage.transact(async (_, transaction) => {
      const current = await this.read(record.target, transaction);
      if (current.status !== "starting") return current;
      const finishedAt = this.now();
      const ready = identity !== undefined && finishedAt < current.deadline;
      const next: RuntimeStageRecord = {
        ...current,
        status: ready ? "ready" : "failed",
        ...(identity ? { identity } : {}),
        ...(ready ? { readyAt: finishedAt } : {}),
      };
      await transaction.put(key(record.target), next);
      return next;
    });
  }
  async begin(proof: StartAuthorization, admit: () => Promise<void>) {
    if (!proof.selection.active) throw new SlotRefused("identity");
    const record: RuntimeStageRecord = {
      operationId: proof.operationId,
      target: proof.target,
      status: "starting",
      deadline: this.now() + 180_000,
    };
    await this.slots.prepareStage(
      proof.target,
      {
        epoch: proof.selection.expectedEpoch,
        active: proof.selection.active,
        digest: proof.selection.policyDigest,
      },
      async (transaction) => {
        if (await transaction.get(key(proof.target))) throw new SlotRefused("uncertain");
        await transaction.put(key(proof.target), record);
      },
    );
    try {
      await admit();
    } catch (error) {
      await this.finish(record);
      throw error;
    }
    const remaining = record.deadline - this.now();
    if (remaining <= 0) {
      await this.finish(record);
      throw new SlotRefused("unhealthy");
    }
    this.pending.add(key(proof.target));
    this.defer(
      (async () => {
        try {
          const identity = await this.slots.startStage(
            proof.target,
            AbortSignal.timeout(remaining),
          );
          await this.finish(record, identity);
        } catch {
          await this.finish(record);
        } finally {
          this.pending.delete(key(proof.target));
        }
      })(),
    );
    return record;
  }
  async inspect(target: SlotTarget) {
    const record = await this.read(target);
    if (record.status !== "starting") return record;
    if (this.now() >= record.deadline) return this.finish(record);
    if (!this.pending.has(key(target))) {
      // Eviction may lose the completion callback, but cannot grant another launch.
      try {
        const identity = await this.slots.verifyCandidate(await this.slots.observeCandidate());
        return this.finish(record, identity);
      } catch {
        return record;
      }
    }
    return record;
  }
}
