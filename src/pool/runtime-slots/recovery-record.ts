import { Schema } from "effect";
import { pendingFields } from "../pending-failure.ts";
import type { SlotIdentity } from "./contract.ts";
import type { RuntimeSlotStorage } from "./storage.ts";

const recordKey = "runtime-slots-v1:last-recovery";
/** Enough rounds to show a pattern; a recovery that refuses for hours keeps only its latest. */
const refusalsKept = 8;

const Refusal = Schema.Struct({
  round: Schema.Number,
  at: Schema.Number,
  reason: Schema.String,
  step: Schema.optional(Schema.String),
  class: Schema.String,
  provider: Schema.optional(Schema.String),
  read: Schema.optional(Schema.NullOr(Schema.String)),
  status: Schema.optional(Schema.Number),
  field: Schema.optional(Schema.String),
  // Only an older Worker's sibling refusal wrote a state; its record still reads with it.
  state: Schema.optional(Schema.String),
});
/**
 * The selected root's last recovery, in closed values only: the boot it restarts, when it was
 * detected, when the root served again, how many rounds it took, and the latest rounds' refusals.
 */
export const RecoveryRecord = Schema.Struct({
  boot: Schema.String,
  detectedAt: Schema.Number,
  readyAt: Schema.NullOr(Schema.Number),
  rounds: Schema.Number,
  refusals: Schema.Array(Refusal),
});
export type RecoveryRecord = typeof RecoveryRecord.Type;
const isRecord = Schema.is(RecoveryRecord);

/** For the controller inspect; another version's shape reads as none, never as a failed inspect. */
export async function lastRecovery(storage: { get(key: string): Promise<unknown> }) {
  const value = await storage.get(recordKey);
  return isRecord(value) ? value : null;
}

/** Written only by the controller's recovery, so a record seen ready stays ready until it writes. */
export class RecoveryRecords {
  private storage: RuntimeSlotStorage;
  private settled = false;
  constructor(storage: RuntimeSlotStorage) {
    this.storage = storage;
  }
  /** A round that found the root not serving: the same boot's open recovery counts one more. */
  async round(previous: SlotIdentity, at: number) {
    const record = await this.change((record) =>
      record && record.boot === previous.bootId && record.readyAt === null
        ? { ...record, rounds: record.rounds + 1 }
        : { boot: previous.bootId, detectedAt: at, readyAt: null, rounds: 1, refusals: [] },
    );
    return record!.rounds;
  }
  async refused(round: number, at: number, error: unknown) {
    const { reason, step, class: errorClass, provider, read, status, field } = pendingFields(error);
    await this.change((record) =>
      record && record.readyAt === null
        ? {
            ...record,
            refusals: [
              ...record.refusals,
              {
                round,
                at,
                reason,
                ...(step ? { step } : {}),
                class: errorClass,
                ...(provider ? { provider, read } : {}),
                ...(status === undefined ? {} : { status }),
                ...(field ? { field } : {}),
              },
            ].slice(-refusalsKept),
          }
        : record,
    );
  }
  /** The root serves: an open recovery ends here. Every healthy pass calls this, so it reads once. */
  async ready(at: number) {
    if (this.settled) return;
    await this.change((record) =>
      record && record.readyAt === null ? { ...record, readyAt: at } : record,
    );
    this.settled = true;
  }
  private change(next: (record: RecoveryRecord | null) => RecoveryRecord | null) {
    this.settled = false;
    return this.storage.plain(async (transaction) => {
      const raw = await transaction.get(recordKey);
      const record = isRecord(raw) ? raw : null;
      const updated = next(record);
      if (updated && updated !== record) await transaction.put(recordKey, updated);
      return updated;
    });
  }
}
