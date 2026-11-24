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
   * Which object instance took each lease whose answer streams through that instance's own code. Code
   * before these two fields ignores them and drops them on its next write, so after a rollback every
   * lease is unstamped again.
   */
  owners: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  /** Which object instance took each model socket's lease; a socket outlives its instance. */
  sockets: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  /** When a stream was last acquired or released; a forced stop reads how long the count stood. */
  changedAt: Schema.optional(Schema.Number),
});

type Row = typeof Activity.Type;
const without = (map: Record<string, string> | undefined, kept: (id: string) => boolean) =>
  map && Object.fromEntries(Object.entries(map).filter(([id]) => kept(id)));

/**
 * Settles released leases, and the leases of plain HTTP calls another object instance took: such an
 * answer streams through its instance's own code and ended with it, though nothing of that instance
 * ran its release. `foreign` counts those.
 */
function reconciled(row: Row, instance: string): { row: Row; foreign: number } {
  if (!row.leases) return { row, foreign: 0 };
  const entries = Object.entries(row.leases);
  if (entries.length > row.active) throw new SlotRefused("uncertain");
  const foreign = (id: string) => row.owners?.[id] !== undefined && row.owners[id] !== instance;
  const live = new Set(
    entries.filter(([id, state]) => state === "active" && !foreign(id)).map(([id]) => id),
  );
  const owners = without(row.owners, (id) => live.has(id));
  const sockets = without(row.sockets, (id) => live.has(id));
  return {
    row: {
      ...row,
      active: row.active - (entries.length - live.size),
      leases: Object.fromEntries([...live].map((id) => [id, "active" as const])),
      ...(owners ? { owners } : {}),
      ...(sockets ? { sockets } : {}),
    },
    foreign: entries.filter(([id, state]) => state === "active" && foreign(id)).length,
  };
}

/**
 * The live leases no instance can vouch for: a lease taken by code before the stamps, and a model
 * socket another instance took. Each may still carry a live connection, so only a read of the
 * container's own connections can end them.
 */
export interface UnprovenLeases {
  unstamped: string[];
  foreignSockets: string[];
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

/**
 * A lease another instance took ends only by proof: its instance's own end for a plain HTTP call, a
 * container read with no live model connection for anything else. Reconstruction never invents an
 * empty runtime.
 */
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
    let foreign = 0;
    const result = await this.storage.transaction(async (transaction) => {
      const value = await transaction.get(this.key(identity));
      if (value === undefined && !allowUntracked) throw new SlotRefused("uncertain");
      const current =
        value === undefined
          ? { identity, phase: "open" as const, active: 0, known: false }
          : Schema.decodeUnknownSync(Activity)(value);
      if (!sameIdentity(current.identity, identity)) throw new SlotRefused("identity");
      const settled = reconcile ? reconciled(current, this.instance) : { row: current, foreign: 0 };
      // Ending a lease moves the count, so the fleet's stand-still before trusting it starts again.
      const next = work(settled.foreign ? { ...settled.row, changedAt: Date.now() } : settled.row);
      await transaction.put(this.key(identity), next.row);
      foreign = settled.foreign;
      return next.result;
    });
    if (foreign) await released(identity, "foreign_http", foreign);
    return result;
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

  /** Settles what this instance can settle by itself, then names what only a proof can end. */
  async unproven(identity: SlotIdentity): Promise<UnprovenLeases> {
    let row = await this.inspect(identity);
    if (!row?.leases) return { unstamped: [], foreignSockets: [] };
    if (reconciled(row, this.instance).foreign) {
      await this.reconcile(identity);
      row = await this.inspect(identity);
    }
    const leases = Object.entries(row?.leases ?? {});
    const ids = leases.filter(([, state]) => state === "active").map(([id]) => id);
    return {
      unstamped: ids.filter((id) => !row?.owners?.[id] && !row?.sockets?.[id]),
      foreignSockets: ids.filter(
        (id) => row?.sockets?.[id] !== undefined && row.sockets[id] !== this.instance,
      ),
    };
  }

  /**
   * Ends every unproven lease after a read found no live connection on the container's model port.
   * Each was taken before that read, since only this instance runs and it stamps every lease it
   * takes; a lease this instance took, before or after the read, is never among them.
   */
  async releaseProven(identity: SlotIdentity, connections: 0) {
    const ended = await this.change(identity, (row) => {
      const ends = (id: string) =>
        row.leases?.[id] === "active" &&
        row.owners?.[id] === undefined &&
        (row.sockets?.[id] === undefined || row.sockets[id] !== this.instance);
      const ids = Object.keys(row.leases ?? {}).filter(ends);
      if (!ids.length) return { row, result: { unstamped: 0, foreignSockets: 0 } };
      return {
        row: {
          ...row,
          active: row.active - ids.length,
          leases: Object.fromEntries(
            Object.entries(row.leases ?? {}).filter(([id]) => !ids.includes(id)),
          ),
          ...(row.sockets ? { sockets: without(row.sockets, (id) => !ids.includes(id)) } : {}),
          changedAt: Date.now(),
        },
        result: {
          unstamped: ids.filter((id) => !row.sockets?.[id]).length,
          foreignSockets: ids.filter((id) => row.sockets?.[id] !== undefined).length,
        },
      };
    });
    if (ended.unstamped) await released(identity, "unstamped", ended.unstamped, connections);
    if (ended.foreignSockets)
      await released(identity, "foreign_socket", ended.foreignSockets, connections);
    return ended;
  }

  /**
   * `endsWithInstance` for a call whose answer streams through this instance's own code: the platform
   * ends that stream with the instance. A model socket passes through natively and outlives a
   * replaced instance (runtime-lease-cancel.workerd.test.ts), so its stamp says so.
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
            ...(endsWithInstance
              ? { owners: { ...row.owners, [id]: this.instance } }
              : { sockets: { ...row.sockets, [id]: this.instance } }),
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

/** One closed line per settlement; the key is the slot's short hash, as the fleet inspect shows it. */
async function released(
  identity: SlotIdentity,
  kind: "foreign_http" | "unstamped" | "foreign_socket",
  count: number,
  connections?: number,
) {
  console.warn("POOL_RUNTIME_LEASES_RELEASED", {
    key: await slotKey(identity.slotId),
    ordinal: identity.homePeerOrdinal ?? null,
    kind,
    released: count,
    ...(connections === undefined ? {} : { connections }),
  });
}

/** The fleet inspect's row key: the slot's SHA-256, first 12 bytes. */
export async function slotKey(slotId: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(slotId));
  return Array.from(new Uint8Array(digest).slice(0, 12), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}
