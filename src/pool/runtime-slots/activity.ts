import { Schema } from "effect";
import { SlotIdentity, SlotRefused, sameIdentity } from "./contract.ts";
import type { TransactionStorage } from "./storage.ts";

const Activity = Schema.Struct({
  identity: SlotIdentity,
  phase: Schema.Literals(["open", "draining", "retiring"]),
  active: Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0)),
  known: Schema.Boolean,
  leases: Schema.optional(Schema.Record(Schema.String, Schema.Literals(["active", "released"]))),
  /** When a stream was last acquired or released; a forced stop reads how long the count stood. */
  changedAt: Schema.optional(Schema.Number),
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

// Leases this isolate acquired and hasn't released: their streams can still be live. A lease taken by
// another isolate died with it, as `legacy-activity.ts` treats a dead isolate's count.
const liveLeases = new Set<string>();

/** Why an operator's override of a still count is refused, in the order the rules apply. */
export type StillRefusal = "not_draining" | "unknown_count" | "still_moving" | "live_lease";
const stillRefusalReason = {
  not_draining: "selection",
  unknown_count: "uncertain",
  still_moving: "draining",
  live_lease: "draining",
} as const;

/**
 * Whether a count may be overridden, and whose leases it holds: `current` were taken by this
 * isolate and may still be live, `gone` were left by an isolate that no longer runs.
 */
function stillCheck(row: typeof Activity.Type | undefined, stillAtLeastMs: number) {
  const leases = Object.keys(row?.leases ?? {});
  const current = leases.filter((lease) => liveLeases.has(lease)).length;
  const stillMs = row ? stillFor(row).stillMs : 0;
  const refusal: StillRefusal | null =
    !row || row.phase !== "draining"
      ? "not_draining"
      : // An unknown count stays the drain's own proof (`drain_unproven`), never an override's.
        !row.known
        ? "unknown_count"
        : row.active === 0
          ? null
          : stillMs < stillAtLeastMs
            ? "still_moving"
            : // A stream this isolate still holds may be live however long it has run.
              current > 0
              ? "live_lease"
              : null;
  return {
    refusal,
    active: row?.active ?? 0,
    known: row?.known ?? false,
    stillMs,
    leases: { current, gone: leases.length - current },
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

  /**
   * An operator's override of a count that no stream has moved for `stillAtLeastMs`. A lease whose
   * release was lost with its object's isolate is released by nothing else. Only a draining, known
   * count with no lease this isolate still holds qualifies, so nothing new can be admitted on it and
   * no stream this isolate serves is cut. Returns what it released and how long it stood.
   */
  releaseStill(identity: SlotIdentity, stillAtLeastMs: number, signal?: AbortSignal) {
    return this.change(identity, (row) => {
      // A caller that gave up never sees this commit, so it never commits.
      signal?.throwIfAborted();
      const check = stillCheck(row, stillAtLeastMs);
      if (check.refusal) throw new SlotRefused(stillRefusalReason[check.refusal]);
      // Nothing left to release, as after a re-send whose first answer was lost.
      if (row.active === 0) return { row, result: { released: 0, stillMs: check.stillMs } };
      return {
        row: { ...row, active: 0, known: true, leases: {}, changedAt: Date.now() },
        result: { released: row.active, stillMs: check.stillMs },
      };
    });
  }

  /** The same rules as `releaseStill`, read without writing anything: the operator's check. */
  async checkStill(identity: SlotIdentity, stillAtLeastMs: number) {
    const row = await this.inspect(identity);
    // The override refuses an untracked boot as uncertain, so the check names it the same way.
    if (!row)
      return {
        ...stillCheck(undefined, stillAtLeastMs),
        refusal: "unknown_count" as const,
        phase: null,
      };
    return { ...stillCheck(reconciled(row), stillAtLeastMs), phase: row.phase };
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
            changedAt: Date.now(),
          },
          result: undefined,
        };
      },
      true,
    );
    liveLeases.add(id);
    let pending: Promise<void> | undefined;
    return () =>
      (pending ??= this.release(identity, id).catch((error) => {
        pending = undefined;
        throw error;
      }));
  }

  private async release(identity: SlotIdentity, id: string) {
    liveLeases.delete(id);
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
