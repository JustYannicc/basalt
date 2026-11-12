import { Schema } from "effect";
import { SlotIdentity, SlotRefused, sameIdentity } from "./contract.ts";
import type { TransactionStorage } from "./storage.ts";

const Activity = Schema.Struct({
  identity: SlotIdentity,
  phase: Schema.Literals(["open", "draining", "retiring"]),
  active: Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0)),
  known: Schema.Boolean,
});

/** Lost request receipts remain counted. Reconstruction cannot invent an empty runtime. */
export class RuntimeActivity {
  private storage: TransactionStorage;
  constructor(storage: TransactionStorage) {
    this.storage = storage;
  }

  private key(identity: SlotIdentity) {
    return `runtime-activity-v1:${JSON.stringify([identity.slotId, identity.bootId])}`;
  }

  private async change<T>(
    identity: SlotIdentity,
    work: (row: typeof Activity.Type) => { row: typeof Activity.Type; result: T },
    allowUntracked = false,
  ) {
    return this.storage.transaction(async (transaction) => {
      const value = await transaction.get(this.key(identity));
      if (value === undefined && !allowUntracked) throw new SlotRefused("uncertain");
      const current =
        value === undefined
          ? { identity, phase: "open" as const, active: 0, known: false }
          : Schema.decodeUnknownSync(Activity)(value);
      if (!sameIdentity(current.identity, identity)) throw new SlotRefused("identity");
      const next = work(current);
      await transaction.put(this.key(identity), next.row);
      return next.result;
    });
  }

  initialize(identity: SlotIdentity, known: boolean) {
    return this.storage.transaction(async (transaction) => {
      const value = await transaction.get(this.key(identity));
      if (value !== undefined) {
        const row = Schema.decodeUnknownSync(Activity)(value);
        if (!sameIdentity(row.identity, identity)) throw new SlotRefused("identity");
        return;
      }
      await transaction.put(this.key(identity), { identity, phase: "open", active: 0, known });
    });
  }

  async acquire(identity: SlotIdentity) {
    await this.change(
      identity,
      (row) => {
        if (row.phase !== "open") throw new SlotRefused("draining");
        if (!Number.isSafeInteger(row.active + 1)) throw new SlotRefused("uncertain");
        return { row: { ...row, active: row.active + 1 }, result: undefined };
      },
      true,
    );
    let released: Promise<void> | undefined;
    return () =>
      (released ??= this.change(identity, (row) => {
        if (row.active < 1) throw new SlotRefused("uncertain");
        return { row: { ...row, active: row.active - 1 }, result: undefined };
      }));
  }

  drain(identity: SlotIdentity) {
    return this.change(
      identity,
      (row) => {
        if (row.phase === "retiring") throw new SlotRefused("uncertain");
        return {
          row: { ...row, phase: "draining" },
          result: { active: row.active, known: row.known },
        };
      },
      true,
    );
  }

  retire(identity: SlotIdentity) {
    return this.change(identity, (row) => {
      if (row.phase === "retiring") throw new SlotRefused("uncertain");
      if (row.phase !== "draining" || row.active !== 0 || !row.known)
        throw new SlotRefused("draining");
      return { row: { ...row, phase: "retiring" }, result: undefined };
    });
  }

  reconcileDrained(identity: SlotIdentity) {
    return this.change(identity, (row) => {
      if (row.phase !== "draining" || row.active !== 0) throw new SlotRefused("draining");
      return { row: { ...row, known: true }, result: { active: 0, known: true } };
    });
  }
}
