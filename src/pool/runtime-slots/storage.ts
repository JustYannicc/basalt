import { Schema } from "effect";
import {
  SlotSelection,
  PromotionReceipt,
  sameTarget,
  slotKey,
  type SlotSnapshot,
} from "./contract.ts";
import type { NativeMembershipPolicy } from "../membership-contract.ts";

export const slotStoragePrefix = "runtime-slots-v1:";
export const slotSelectionKey = `${slotStoragePrefix}selection`;
export const slotFirstStartKey = `${slotStoragePrefix}first-start`;
export const nativeMembershipKey = "native-pool-memberships-v1";
export interface SlotStorage {
  get<T>(key: string): Promise<T | undefined>;
  put(key: string, value: unknown): Promise<unknown>;
}
export interface TransactionStorage extends SlotStorage {
  transaction<T>(work: (transaction: SlotStorage) => Promise<T>): Promise<T>;
}
const Membership = Schema.Struct({
  pool: Schema.String,
  organization: Schema.String,
  revision: Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(1)),
  expiresAt: Schema.Number,
  accounts: Schema.Array(Schema.String),
  dirty: Schema.Boolean,
  native: Schema.Boolean,
  retired: Schema.optional(Schema.Struct({ resumeAfter: Schema.Number })),
});
const Memberships = Schema.Record(Schema.String, Membership);

/** Reads the authoritative membership record in the same transaction as selection. */
export class RuntimeSlotStorage {
  private storage: TransactionStorage;
  constructor(storage: TransactionStorage) {
    this.storage = storage;
  }

  transact<T>(work: (snapshot: SlotSnapshot, transaction: SlotStorage) => Promise<T>) {
    return this.storage.transaction(async (transaction) => {
      const selection = await transaction.get<unknown>(slotSelectionKey);
      const rows = Schema.decodeUnknownSync(Memberships)(
        (await transaction.get<unknown>(nativeMembershipKey)) ?? {},
      );
      const allPolicies: NativeMembershipPolicy[] = Object.entries(rows)
        .map(([key, row]) => {
          if (key !== row.pool) throw new Error("Pool membership key mismatch");
          return {
            pool: row.pool,
            organization: row.organization,
            revision: row.revision,
            expiresAt: row.expiresAt,
            accounts: [...row.accounts].sort(),
            dirty: row.dirty || !row.native,
          };
        })
        .sort((left, right) => left.pool.localeCompare(right.pool));
      const fingerprint = JSON.stringify(
        allPolicies.map(({ pool, organization, revision, accounts, dirty }) => ({
          pool,
          organization,
          revision,
          accounts,
          dirty,
        })),
      );
      const digest = Array.from(
        new Uint8Array(
          await crypto.subtle.digest("SHA-256", new TextEncoder().encode(fingerprint)),
        ),
        (byte) => byte.toString(16).padStart(2, "0"),
      ).join("");
      const decoded =
        selection === undefined ? undefined : Schema.decodeUnknownSync(SlotSelection)(selection);
      if (decoded) {
        const slots = [decoded.active, decoded.candidate, decoded.draining].filter(
          (slot) => slot !== undefined,
        );
        if (
          !decoded.active.identity ||
          decoded.epoch < 1 ||
          (decoded.candidate && decoded.draining) ||
          new Set(slots.map((slot) => slotKey(slot.target))).size !== slots.length ||
          slots.some(
            (slot) =>
              slot.target.controllerId !== decoded.active.target.controllerId ||
              (slot.identity && !sameTarget(slot.target, slot.identity)),
          )
        )
          throw new Error("Invalid runtime slot selection");
      }
      return work(
        {
          ...(decoded === undefined ? {} : { selection: decoded }),
          policies: allPolicies.filter((policy) => !rows[policy.pool]!.retired),
          denials: allPolicies.filter((policy) => rows[policy.pool]!.retired),
          digest,
        },
        transaction,
      );
    });
  }

  inspect() {
    return this.transact(async (snapshot) => snapshot);
  }
  async receipt(operationId: string) {
    const value = await this.storage.get<unknown>(this.receiptKey(operationId));
    return value === undefined ? undefined : Schema.decodeUnknownSync(PromotionReceipt)(value);
  }
  receiptKey(operationId: string) {
    if (!/^[a-zA-Z0-9-]{1,128}$/u.test(operationId)) throw new Error("Invalid promotion operation");
    return `${slotStoragePrefix}receipt:${operationId}`;
  }
}
