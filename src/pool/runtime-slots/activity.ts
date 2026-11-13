import { Schema } from "effect";
import { SlotIdentity, SlotRefused, sameIdentity } from "./contract.ts";
import type { TransactionStorage } from "./storage.ts";

const Activity = Schema.Struct({
  identity: SlotIdentity,
  phase: Schema.Literals(["open", "draining", "retiring"]),
  active: Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0)),
  known: Schema.Boolean,
  leases: Schema.optional(Schema.Record(Schema.String, Schema.Literals(["active", "released"]))),
});

function reconciled(row: typeof Activity.Type) {
  if (!row.leases) return row;
  const released = Object.values(row.leases).filter((state) => state === "released").length;
  if (Object.keys(row.leases).length > row.active) throw new SlotRefused("uncertain");
  return {
    ...row,
    active: row.active - released,
    leases: Object.fromEntries(
      Object.entries(row.leases).filter(([, state]) => state !== "released"),
    ),
  };
}

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
    reconcile = true,
  ) {
    return this.storage.transaction(async (transaction) => {
      const value = await transaction.get(this.key(identity));
      if (value === undefined && !allowUntracked) throw new SlotRefused("uncertain");
      const current =
        value === undefined
          ? { identity, phase: "open" as const, active: 0, known: false }
          : Schema.decodeUnknownSync(Activity)(value);
      if (!sameIdentity(current.identity, identity)) throw new SlotRefused("identity");
      const next = work(reconcile ? reconciled(current) : current);
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

  async inspect(identity: SlotIdentity) {
    const value = await this.storage.get(this.key(identity));
    if (value === undefined) return undefined;
    const row = Schema.decodeUnknownSync(Activity)(value);
    if (!sameIdentity(row.identity, identity)) throw new SlotRefused("identity");
    return row;
  }

  async acquire(identity: SlotIdentity) {
    const id = crypto.randomUUID();
    await this.change(
      identity,
      (row) => {
        if (row.phase !== "open") throw new SlotRefused("draining");
        if (!Number.isSafeInteger(row.active + 1)) throw new SlotRefused("uncertain");
        return {
          row: {
            ...row,
            active: row.active + 1,
            leases: { ...row.leases, [id]: "active" as const },
          },
          result: undefined,
        };
      },
      true,
    );
    let pending: Promise<void> | undefined;
    return () =>
      (pending ??= this.release(identity, id).catch((error) => {
        pending = undefined;
        throw error;
      }));
  }

  private async release(identity: SlotIdentity, id: string) {
    // Commit completion separately from decrement. A rejected decrement remains recoverable after reconstruction.
    await this.change(
      identity,
      (row) => ({
        row:
          row.leases?.[id] === "active"
            ? { ...row, leases: { ...row.leases, [id]: "released" as const } }
            : row,
        result: undefined,
      }),
      false,
      false,
    );
    await this.change(identity, (row) => ({ row, result: undefined }));
  }

  reconcile(identity: SlotIdentity) {
    return this.change(identity, (row) => ({ row, result: undefined }));
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
