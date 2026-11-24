import { Schema } from "effect";
import { SlotIdentity, SlotRefused, sameIdentity } from "./contract.ts";
import type { TransactionStorage } from "./storage.ts";

const Activity = Schema.Struct({
  identity: SlotIdentity,
  phase: Schema.Literals(["open", "draining", "retiring"]),
  active: Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0)),
  known: Schema.Boolean,
  leases: Schema.optional(Schema.Record(Schema.String, Schema.Literals(["active", "released"]))),
  /**
   * Which object instance took each stamped lease. Code before this field ignores it and drops it on
   * its next write, so after a rollback every lease is unstamped again, and an unstamped lease is live.
   */
  owners: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  /** When a stream was last acquired or released; a forced stop reads how long the count stood. */
  changedAt: Schema.optional(Schema.Number),
});

/**
 * A call lives only as long as the object instance that took its lease: its stream runs through that
 * instance, and the platform ends every request of an instance it replaces. So a lease another
 * instance took is over, though nothing of that instance ran its release.
 */
function reconciled(row: typeof Activity.Type, instance: string) {
  if (!row.leases) return row;
  const over = (id: string, state: "active" | "released") =>
    state === "released" || (row.owners?.[id] !== undefined && row.owners[id] !== instance);
  const entries = Object.entries(row.leases);
  if (entries.length > row.active) throw new SlotRefused("uncertain");
  const live = entries.filter(([id, state]) => !over(id, state));
  const owners =
    row.owners &&
    Object.fromEntries(
      Object.entries(row.owners).filter(([id]) => live.some(([kept]) => kept === id)),
    );
  return {
    ...row,
    active: row.active - (entries.length - live.length),
    leases: Object.fromEntries(live),
    ...(owners ? { owners } : {}),
  };
}

// The platform builds a new storage object for each object instance; Workers refuse random values
// at global scope, so an instance is named on its first lease.
const instances = new WeakMap<object, string>();

/**
 * How long the count stood still, as a duration, so no caller compares this clock with its own. Every
 * acquire and release stamps `changedAt`, so a row without one never moved since it was set up.
 */
export function stillFor(row: Pick<typeof Activity.Type, "changedAt">) {
  return {
    stillMs:
      row.changedAt === undefined
        ? Number.MAX_SAFE_INTEGER
        : Math.max(0, Date.now() - row.changedAt),
  };
}

/** Lost request receipts remain counted. Reconstruction cannot invent an empty runtime. */
export class RuntimeActivity {
  private storage: TransactionStorage;
  private scope?: string;
  constructor(storage: TransactionStorage, instance?: string) {
    this.storage = storage;
    this.scope = instance;
  }
  private get instance() {
    if (this.scope) return this.scope;
    let named = instances.get(this.storage);
    if (!named) instances.set(this.storage, (named = crypto.randomUUID()));
    return (this.scope = named);
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
      const next = work(reconcile ? reconciled(current, this.instance) : current);
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
    return reconciled(row, this.instance);
  }

  /**
   * `endsWithInstance` only for a call whose answer streams through this instance's own code: the
   * platform ends that stream with the instance. A model socket passes through natively and outlives
   * a replaced instance (runtime-lease-cancel.workerd.test.ts), so its lease is never stamped.
   */
  async acquire(identity: SlotIdentity, endsWithInstance = false) {
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
            ...(endsWithInstance || row.owners
              ? { owners: { ...row.owners, ...(endsWithInstance ? { [id]: this.instance } : {}) } }
              : {}),
            changedAt: Date.now(),
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
            ? {
                ...row,
                leases: { ...row.leases, [id]: "released" as const },
                changedAt: Date.now(),
              }
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
