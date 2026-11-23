import { Schema } from "effect";
import { SlotIdentity, SlotTarget, sameIdentity, sameTarget } from "../runtime-slots/contract.ts";
import type { SlotStorage, TransactionStorage } from "../runtime-slots/storage.ts";
import { physicalPrimaryTargets, sameGeneration, selectedPrimary } from "./physical.ts";
import { slotFirstStartKey } from "../runtime-slots/storage.ts";
import { runtimeCellKey } from "./cell-state.ts";
import { RuntimeDistance, distanceClass, type DistanceClass } from "../runtime-distance.ts";
import { RuntimeEnd } from "../runtime-slots/container-end.ts";
import { logQuarantine, type PhaseBound } from "./phase-bounds.ts";
import type { FleetFailure } from "./failure-record.ts";

const Count = Schema.Number.check(
  Schema.isInt(),
  Schema.isBetween({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
);
const quarantineReasons = [
  "runtime_failed",
  "policy_refused",
  "start_unproven",
  "drain_unproven",
  "absence_unproven",
] as const;
const Row = Schema.Struct({
  target: SlotTarget,
  identity: Schema.optional(SlotIdentity),
  replaces: Schema.optional(SlotIdentity),
  phase: Schema.Literals([
    "reserved",
    "warming",
    "ready",
    "draining",
    "retiring",
    "uncertain",
    "quarantined",
    "retired",
  ]),
  active: Count,
  drainAcknowledged: Schema.optional(Schema.Boolean),
  lastUsedAt: Count,
  database: Schema.optional(RuntimeDistance),
  // Reserved against quarantine demand; a planned replacement carries `replaces` instead.
  replacement: Schema.optional(Schema.Boolean),
  // Sent to draining by a far-placement redraw, never by load or retirement.
  redrawn: Schema.optional(Schema.Boolean),
  // When the row entered its phase. A row stored before this existed is stamped by its next write.
  phaseAt: Schema.optional(Count),
  // Why a quarantined row holds its place; rows quarantined before this existed carry none.
  reason: Schema.optional(Schema.Literals(quarantineReasons)),
  // How the cell's container ended, copied when the row leaves; opaque, so it never fails a decode.
  end: Schema.optional(Schema.Unknown),
  // The row's reads since its last good one were not good: it takes no new call until a good read
  // clears this. Opaque like `failure`; the fleet's failures read it with a closed check.
  suspect: Schema.optional(Schema.Unknown),
  // Why the fleet quarantined it: the path that saw the failure and every read that counted.
  failure: Schema.optional(Schema.Unknown),
});
type Row = typeof Row.Type;
export type FleetRow = Row;
export type QuarantineReason = (typeof quarantineReasons)[number];
const Ledger = Schema.Array(Row);
const key = "runtime-fleet-v1:resources";
const primaryKey = "runtime-fleet-v1:primary-active";
const replacementKey = "runtime-fleet-v1:replacement-demand";
const retiredKey = (slot: string) => `runtime-fleet-v1:retired:${slot}`;
/** The ends of the cells that left last, newest first, which the fleet inspect returns. */
const recentEndsKey = "runtime-fleet-v1:recent-ends";
const recentEnds = 8;
const isRecentEnd = Schema.is(
  Schema.Struct({
    slotId: Schema.String,
    end: Schema.NullOr(RuntimeEnd),
    // How the cell left, and for a quarantine why; entries kept before these existed carry none.
    left: Schema.optional(Schema.Literals(["retired", "quarantined"])),
    reason: Schema.optional(Schema.NullOr(Schema.Literals(quarantineReasons))),
    failure: Schema.optional(Schema.Unknown),
  }),
);
/** The kept ends this code can read; anything else is dropped, never a failed retirement. */
const readRecentEnds = (value: unknown) => (Array.isArray(value) ? value.filter(isRecentEnd) : []);
interface RuntimeReservation {
  kind: "runtime";
  identity: SlotIdentity;
  release(): Promise<void>;
}
interface PrimaryReservation {
  kind: "primary";
  /** No cell was ready: the root takes the call as the fleet's only route. */
  alone: boolean;
  release(): Promise<void>;
}
/**
 * How the root takes a call beside ready cells. Balanced, it ranks with them and keeps its tie
 * preference within a tier; last, it takes one only when no ready cell can. Either way its calls
 * are counted reservations, so growth still reads them after the controller restarts.
 */
export type PrimaryRoute = "balanced" | "last";

/** Where runtimes sit relative to the database. Without it, routing is unchanged. */
export interface FleetPlacement {
  // The growth target: near runtimes under it come first, then everything else under it.
  comfortable: number;
  primary: DistanceClass;
}
const tier = (placement: FleetPlacement | undefined, place: DistanceClass, active: number) => {
  if (!placement) return 0;
  const near = place === "near";
  if (active < placement.comfortable) return near ? 0 : 1;
  return near ? 2 : 3;
};

export class FleetRefused extends Error {
  readonly reason: "capacity" | "identity" | "uncertain" | "draining";
  constructor(reason: FleetRefused["reason"]) {
    super(`Pool runtime fleet refused: ${reason}`);
    this.reason = reason;
  }
}

/** A lost launch or release receipt consumes capacity until an explicit observation resolves it. */
export class RuntimeFleetState {
  private storage: TransactionStorage;
  private maximum: number;
  private now: () => number;
  private permission?: (target: SlotTarget, transaction: SlotStorage) => Promise<void>;
  constructor(
    storage: TransactionStorage,
    maximum: number,
    now = Date.now,
    permission?: RuntimeFleetState["permission"],
  ) {
    if (!Number.isInteger(maximum) || maximum < 1 || maximum > 4)
      throw new Error("Runtime fleet exceeds its approved resource bound");
    this.storage = storage;
    this.maximum = maximum;
    this.now = now;
    this.permission = permission;
  }
  private rows(value: unknown) {
    const rows = [...Schema.decodeUnknownSync(Ledger)(value ?? [])];
    const live = rows.filter((row) => row.phase !== "retired");
    if (
      live.length > this.maximum ||
      new Set(rows.map((row) => row.target.slotId)).size !== rows.length ||
      new Set(live.map((row) => row.target.instanceId)).size !== live.length ||
      new Set(live.map((row) => row.target.homePeerOrdinal)).size !== live.length ||
      live.some((row) => row.target.homePeerOrdinal === undefined) ||
      rows.some((row) => row.identity && !sameTarget(row.target, row.identity))
    )
      throw new FleetRefused("uncertain");
    return rows;
  }
  /** Every phase change stamps its entry time, so each phase's bound counts from one durable instant. */
  private stamp(rows: Row[], before: ReadonlyMap<string, Row["phase"]>) {
    const entered: Row[] = [];
    rows.forEach((row, index) => {
      const changed = before.get(row.target.slotId) !== row.phase;
      if (!changed && row.phaseAt !== undefined) return;
      rows[index] = { ...row, phaseAt: this.now() };
      if (changed && row.phase === "quarantined") entered.push(rows[index]);
    });
    return entered;
  }
  private async change<T>(work: (rows: Row[], transaction: SlotStorage) => T | Promise<T>) {
    let entered: Row[] = [];
    const value = await this.storage.transaction(async (transaction) => {
      const rows = this.rows(await transaction.get(key));
      const before = new Map(rows.map((row) => [row.target.slotId, row.phase]));
      const value = await work(rows, transaction);
      entered = this.stamp(rows, before);
      this.rows(rows);
      await transaction.put(key, rows);
      return value;
    });
    for (const row of entered) logQuarantine("entered", row, 0);
    return value;
  }
  /** Gives rows stored before phase times existed their entry time, counted from now. */
  stampPhases() {
    return this.change(() => {});
  }
  async inspect(storage: SlotStorage = this.storage) {
    return this.rows(await storage.get(key));
  }
  async physicalCount(storage: SlotStorage = this.storage) {
    return (
      (await this.inspect(storage)).filter((row) => row.phase !== "retired").length +
      (await physicalPrimaryTargets(storage)).length
    );
  }
  async replacements(storage: SlotStorage = this.storage) {
    const count = Schema.decodeUnknownSync(Count)((await storage.get(replacementKey)) ?? 0);
    if (count > this.maximum) throw new FleetRefused("uncertain");
    return count;
  }
  reserveReplacement(value: SlotTarget) {
    return this.reserve(value, undefined, { replacement: true });
  }
  reserve(
    value: SlotTarget,
    retained?: (transaction: SlotStorage) => Promise<void>,
    options: { replacement?: boolean; previous?: SlotIdentity } = {},
  ) {
    const target = Schema.decodeUnknownSync(SlotTarget)(value);
    return this.change(async (rows, transaction) => {
      await this.permission?.(target, transaction);
      const live = rows.filter((row) => row.phase !== "retired");
      if (live.length + (await physicalPrimaryTargets(transaction)).length >= this.maximum)
        throw new FleetRefused("capacity");
      if (
        target.homePeerOrdinal === undefined ||
        rows.some((row) => row.target.slotId === target.slotId) ||
        (await transaction.get(retiredKey(target.slotId))) !== undefined ||
        live.some(
          (row) =>
            row.target.instanceId === target.instanceId ||
            row.target.homePeerOrdinal === target.homePeerOrdinal ||
            row.target.controllerId !== target.controllerId,
        )
      )
        throw new FleetRefused("identity");
      await retained?.(transaction);
      if (options.replacement) {
        const remaining = await this.replacements(transaction);
        if (remaining < 1) throw new FleetRefused("uncertain");
        await transaction.put(replacementKey, remaining - 1);
      }
      rows.push({
        target,
        phase: "reserved",
        active: 0,
        lastUsedAt: this.now(),
        ...(options.previous ? { replaces: options.previous } : {}),
        ...(options.replacement ? { replacement: true } : {}),
      });
    });
  }
  private row(rows: Row[], target: SlotTarget) {
    const row = rows.find((row) => row.target.slotId === target.slotId);
    if (!row || !sameTarget(row.target, target)) throw new FleetRefused("identity");
    return row;
  }
  dispatch(target: SlotTarget) {
    return this.change((rows) => {
      const row = this.row(rows, target);
      if (row.phase !== "reserved") throw new FleetRefused("uncertain");
      rows[rows.indexOf(row)] = { ...row, phase: "warming" };
    });
  }
  uncertain(target: SlotTarget) {
    return this.change((rows) => {
      const row = this.row(rows, target);
      if (!["reserved", "warming", "uncertain"].includes(row.phase))
        throw new FleetRefused("uncertain");
      rows[rows.indexOf(row)] = { ...row, phase: "uncertain" };
    });
  }
  /**
   * A started cell that landed far goes straight to draining, so no request is ever routed to it.
   * Returns false when this boot was already redrawn; replacements are never redrawn.
   */
  redraw(value: SlotIdentity, database: RuntimeDistance | undefined) {
    const identity = Schema.decodeUnknownSync(SlotIdentity)(value);
    return this.change((rows) => {
      const row = this.row(rows, identity);
      if (row.phase === "draining" && row.redrawn && sameIdentity(row.identity, identity))
        return false;
      if (
        !["warming", "uncertain"].includes(row.phase) ||
        row.active !== 0 ||
        row.replaces !== undefined ||
        row.replacement === true ||
        (row.identity && !sameIdentity(row.identity, identity))
      )
        throw new FleetRefused("uncertain");
      rows[rows.indexOf(row)] = {
        ...row,
        phase: "draining",
        identity,
        redrawn: true,
        lastUsedAt: this.now(),
        ...(database ? { database } : {}),
      };
      return true;
    });
  }
  /** A redrawn cell nobody used comes back when the runtime that justified the redraw stopped. */
  restoreRedrawn(value: SlotIdentity) {
    const identity = Schema.decodeUnknownSync(SlotIdentity)(value);
    return this.change((rows) => {
      const row = this.row(rows, identity);
      if (
        row.phase !== "draining" ||
        !row.redrawn ||
        row.active !== 0 ||
        row.drainAcknowledged === true ||
        !sameIdentity(row.identity, identity)
      )
        return false;
      const { redrawn: _redrawn, ...rest } = row;
      rows[rows.indexOf(row)] = { ...rest, phase: "ready" };
      return true;
    });
  }
  /** Records a ready runtime's reported distance; an unchanged value writes nothing. */
  async observeDistance(value: SlotIdentity, database: RuntimeDistance | undefined) {
    const identity = Schema.decodeUnknownSync(SlotIdentity)(value);
    const current = (await this.inspect()).find((row) => sameIdentity(row.identity, identity));
    if (!current || JSON.stringify(current.database) === JSON.stringify(database)) return;
    await this.change((rows) => {
      const row = rows.find((row) => sameIdentity(row.identity, identity));
      if (!row) return;
      const { database: _previous, ...rest } = row;
      rows[rows.indexOf(row)] = database ? { ...rest, database } : rest;
    });
  }
  ready(value: SlotIdentity, database?: RuntimeDistance) {
    const identity = Schema.decodeUnknownSync(SlotIdentity)(value);
    return this.change(async (rows, transaction) => {
      const row = this.row(rows, identity);
      if (
        !["warming", "uncertain", "ready"].includes(row.phase) ||
        (row.identity && !sameIdentity(row.identity, identity))
      )
        throw new FleetRefused("uncertain");
      const primary = await selectedPrimary(transaction);
      rows[rows.indexOf(row)] = {
        ...row,
        phase:
          primary &&
          primary.instanceId !== primary.controllerId &&
          !sameGeneration(primary, identity)
            ? "draining"
            : "ready",
        identity,
        lastUsedAt: row.phase === "ready" ? row.lastUsedAt : this.now(),
        ...(database ? { database } : {}),
      };
    });
  }
  async promoteGeneration(primary: SlotTarget, transaction: SlotStorage) {
    const rows = this.rows(await transaction.get(key));
    // Reservation is the cut: earlier sends drain normally; later acquisitions cannot select old cells.
    const retained: Row[] = [];
    for (const row of rows) {
      if (sameGeneration(row.target, primary)) {
        retained.push(row);
        continue;
      }
      if (
        ["reserved", "warming", "uncertain"].includes(row.phase) &&
        !row.identity &&
        row.active === 0 &&
        (await transaction.get(runtimeCellKey(row.target.slotId, slotFirstStartKey))) === undefined
      ) {
        await transaction.put(retiredKey(row.target.slotId), { ...row, phase: "retired" });
        await this.keepEnd(transaction, row);
      } else retained.push(row.phase === "ready" ? { ...row, phase: "draining" } : row);
    }
    this.stamp(retained, new Map(rows.map((row) => [row.target.slotId, row.phase])));
    await transaction.put(key, retained);
  }
  cancelReserved(target: SlotTarget) {
    return this.change(async (rows, transaction) => {
      const row = this.row(rows, target);
      if (row.phase !== "reserved" || row.identity || row.active !== 0)
        throw new FleetRefused("uncertain");
      await transaction.put(retiredKey(target.slotId), { ...row, phase: "retired" });
      await this.keepEnd(transaction, row);
      rows.splice(rows.indexOf(row), 1);
    });
  }
  async primaryActive() {
    return Schema.decodeUnknownSync(Count)((await this.storage.get(primaryKey)) ?? 0);
  }
  acquire(
    capacity: number,
    primary?: undefined,
    placement?: FleetPlacement,
    fenced?: (identity: SlotIdentity) => boolean,
  ): Promise<RuntimeReservation>;
  acquire(
    capacity: number,
    primary: PrimaryRoute,
    placement?: FleetPlacement,
    fenced?: (identity: SlotIdentity) => boolean,
  ): Promise<RuntimeReservation | PrimaryReservation>;
  /** `fenced` is the controller's local fence, for a read not yet in the durable row. */
  async acquire(
    capacity: number,
    primary?: PrimaryRoute,
    placement?: FleetPlacement,
    fenced?: (identity: SlotIdentity) => boolean,
  ): Promise<RuntimeReservation | PrimaryReservation> {
    if (!Number.isSafeInteger(capacity) || capacity < 1)
      throw new Error("Invalid measured runtime capacity");
    const selected = await this.change<
      { kind: "runtime"; identity: SlotIdentity } | { kind: "primary"; alone: boolean }
    >(async (rows, transaction) => {
      const rank = (row: Row) => tier(placement, distanceClass(row.database), row.active);
      const available = rows
        // A row with a failed health read takes no new call until a good read clears it.
        .filter(
          (row) =>
            row.phase === "ready" &&
            row.suspect === undefined &&
            !(row.identity && fenced?.(row.identity)) &&
            row.active < capacity,
        )
        .sort(
          (left, right) =>
            rank(left) - rank(right) ||
            left.active - right.active ||
            left.lastUsedAt - right.lastUsedAt,
        );
      const row = available[0];
      if (primary) {
        const active = Schema.decodeUnknownSync(Count)((await transaction.get(primaryKey)) ?? 0);
        const primaryRank = tier(placement, placement?.primary ?? "unknown", active);
        if (
          !row ||
          (primary === "balanced" &&
            (primaryRank < rank(row) || (primaryRank === rank(row) && active <= row.active)))
        ) {
          if (!Number.isSafeInteger(active + 1)) throw new FleetRefused("uncertain");
          await transaction.put(primaryKey, active + 1);
          return { kind: "primary", alone: !row };
        }
      }
      if (!row?.identity) throw new FleetRefused("capacity");
      rows[rows.indexOf(row)] = { ...row, active: row.active + 1, lastUsedAt: this.now() };
      return { kind: "runtime", identity: row.identity };
    });
    let released: Promise<void> | undefined;
    const release = () =>
      (released ??= this.change(async (rows, transaction) => {
        if (selected.kind === "primary") {
          const count = Schema.decodeUnknownSync(Count)(await transaction.get(primaryKey));
          if (count < 1) throw new FleetRefused("uncertain");
          await transaction.put(primaryKey, count - 1);
          return;
        }
        const identity = selected.identity;
        const live = rows.find((row) => sameTarget(row.target, identity));
        const row =
          live ?? Schema.decodeUnknownSync(Row)(await transaction.get(retiredKey(identity.slotId)));
        if (!sameIdentity(row.identity, identity) || row.active === 0)
          throw new FleetRefused("uncertain");
        const next = { ...row, active: row.active - 1, lastUsedAt: this.now() };
        if (live) rows[rows.indexOf(live)] = next;
        else await transaction.put(retiredKey(identity.slotId), next);
      }));
    return selected.kind === "primary"
      ? { kind: "primary", alone: selected.alone, release }
      : { kind: "runtime", identity: selected.identity, release };
  }
  quarantine(
    identity: SlotIdentity,
    reason: QuarantineReason = "runtime_failed",
    failure?: FleetFailure,
  ) {
    return this.change(async (rows, transaction) => {
      if (!rows.some((row) => sameTarget(row.target, identity))) {
        const retired = Schema.decodeUnknownSync(Row)(
          await transaction.get(retiredKey(identity.slotId)),
        );
        if (sameIdentity(retired.identity, identity) && retired.phase === "quarantined") return;
        throw new FleetRefused("identity");
      }
      const row = this.row(rows, identity);
      if (
        !sameIdentity(row.identity, identity) ||
        !["ready", "draining", "retiring", "quarantined"].includes(row.phase)
      )
        throw new FleetRefused("identity");
      if (row.phase === "quarantined") return;
      await this.quarantineRow(rows, transaction, identity, reason, failure);
    });
  }
  /**
   * A ready row's read that was not good, decided in one transaction: `decide` sees the row's
   * current suspect record and returns the next one, or the failure to quarantine it with.
   */
  suspect(
    identity: SlotIdentity,
    decide: (
      current: unknown,
    ) => { suspect: unknown } | { quarantine: FleetFailure } | { unchanged: true },
  ) {
    return this.change<"suspect" | "quarantined" | "gone" | "unchanged">(
      async (rows, transaction) => {
        const row = rows.find((value) => sameIdentity(value.identity, identity));
        if (row?.phase === "quarantined") return "quarantined";
        if (!row || row.phase !== "ready") return "gone";
        const next = decide(row.suspect);
        if ("unchanged" in next) return "unchanged";
        if ("quarantine" in next) {
          await this.quarantineRow(rows, transaction, identity, "runtime_failed", next.quarantine);
          return "quarantined";
        }
        rows[rows.indexOf(row)] = { ...row, suspect: next.suspect };
        return "suspect";
      },
    );
  }
  /**
   * A good read: true when the row is ready and takes calls again. `clears` sees the row's suspect
   * record, so a failure recorded after the good read began keeps the row fenced.
   */
  clearSuspect(identity: SlotIdentity, clears: (current: unknown) => boolean = () => true) {
    return this.change((rows) => {
      const row = rows.find((value) => sameIdentity(value.identity, identity));
      if (!row || row.phase !== "ready") return false;
      if (row.suspect !== undefined && !clears(row.suspect)) return false;
      const { suspect: _suspect, ...rest } = row;
      rows[rows.indexOf(row)] = rest;
      return true;
    });
  }
  private async quarantineRow(
    rows: Row[],
    transaction: SlotStorage,
    identity: SlotIdentity,
    reason: QuarantineReason,
    failure: FleetFailure | undefined,
  ) {
    const row = this.row(rows, identity);
    if (
      !rows.some(
        (replacement) =>
          sameIdentity(replacement.replaces, identity) &&
          ["reserved", "warming", "uncertain", "ready"].includes(replacement.phase),
      )
    ) {
      const demand = await this.replacements(transaction);
      if (demand >= this.maximum) throw new FleetRefused("uncertain");
      await transaction.put(replacementKey, demand + 1);
    }
    const { suspect: _suspect, ...rest } = row;
    rows[rows.indexOf(row)] = {
      ...rest,
      phase: "quarantined",
      reason,
      ...(failure ? { failure } : {}),
    };
  }
  /**
   * A row past its phase bound takes no call and holds its place until the provider proves the
   * instance gone. It adds no replacement demand: growth sees past quarantined rows instead, so a
   * start that keeps failing can't feed itself more starts.
   */
  exceed(target: SlotTarget, phase: Row["phase"], phaseAt: number, reason: PhaseBound) {
    return this.change((rows) => {
      const row = this.row(rows, target);
      if (row.phase !== phase || row.phaseAt !== phaseAt) return false;
      const { suspect: _suspect, ...rest } = row;
      rows[rows.indexOf(row)] = { ...rest, phase: "quarantined", reason };
      return true;
    });
  }
  /**
   * A start refused before its durable first-start intent was written reached no container, so
   * waiting out its bound proves nothing more: it leaves its starting phase at once, with the
   * refusal. Like a bound it adds no replacement demand and still holds its place until the cell's
   * abandon proves nothing runs. False when the row already left its starting phases.
   */
  startRefused(target: SlotTarget, failure: FleetFailure) {
    return this.change((rows) => {
      const row = this.row(rows, target);
      if (row.identity || !["reserved", "warming", "uncertain"].includes(row.phase)) return false;
      const { suspect: _suspect, ...rest } = row;
      rows[rows.indexOf(row)] = {
        ...rest,
        phase: "quarantined",
        reason: "start_unproven",
        failure,
      };
      return true;
    });
  }
  /** A start that never served frees its place once its cell proved the instance gone. */
  reclaimUnstarted(target: SlotTarget) {
    return this.change(async (rows, transaction) => {
      const row = this.row(rows, target);
      if (row.phase !== "quarantined" || row.identity || row.active !== 0)
        throw new FleetRefused("identity");
      await transaction.put(retiredKey(target.slotId), row);
      await this.keepEnd(transaction, row);
      // A demand replacement that never served still owes the replacement it reserved against.
      if (row.replacement === true)
        await transaction.put(
          replacementKey,
          Math.min(this.maximum, (await this.replacements(transaction)) + 1),
        );
      rows.splice(rows.indexOf(row), 1);
    });
  }
  /**
   * Lowers a lost release's count to the cell's own count, never below it, and only while the
   * ledger stands exactly as it was read, so a call admitted or released since then keeps it.
   */
  reconcileActive(identity: SlotIdentity, seen: Pick<Row, "active" | "lastUsedAt">, cell: number) {
    return this.change((rows) => {
      const row = this.row(rows, identity);
      if (
        !sameIdentity(row.identity, identity) ||
        (row.phase !== "ready" && row.phase !== "draining") ||
        row.active !== seen.active ||
        row.lastUsedAt !== seen.lastUsedAt ||
        !Number.isSafeInteger(cell) ||
        cell < 0 ||
        cell >= row.active
      )
        return false;
      rows[rows.indexOf(row)] = { ...row, active: cell };
      return true;
    });
  }
  reclaimQuarantined(identity: SlotIdentity, end?: RuntimeEnd) {
    return this.change(async (rows, transaction) => {
      const row = this.row(rows, identity);
      if (!sameIdentity(row.identity, identity) || row.phase !== "quarantined")
        throw new FleetRefused("identity");
      // Process absence releases compute capacity, not the retained request outcome or count.
      await transaction.put(retiredKey(identity.slotId), end ? { ...row, end } : row);
      await this.keepEnd(transaction, row, end);
      rows.splice(rows.indexOf(row), 1);
    });
  }
  /** Every row that leaves, with or without a recorded end, and for a quarantine why. */
  private async keepEnd(transaction: SlotStorage, row: Row, end?: RuntimeEnd) {
    const kept = readRecentEnds(await transaction.get(recentEndsKey));
    const entry = {
      slotId: row.target.slotId,
      end: end ?? null,
      left: row.phase === "quarantined" ? ("quarantined" as const) : ("retired" as const),
      reason: row.reason ?? null,
      ...(row.failure === undefined ? {} : { failure: row.failure }),
    };
    await transaction.put(recentEndsKey, [entry, ...kept].slice(0, recentEnds));
  }
  async recentEnds(storage: SlotStorage = this.storage) {
    return readRecentEnds(await storage.get(recentEndsKey));
  }
  async released(identity: SlotIdentity) {
    const value = await this.storage.get(retiredKey(identity.slotId));
    if (value === undefined) return false;
    const row = Schema.decodeUnknownSync(Row)(value);
    return sameIdentity(row.identity, identity) && ["retired", "quarantined"].includes(row.phase);
  }
  drain(identity: SlotIdentity) {
    return this.change((rows) => {
      const row = this.row(rows, identity);
      if (sameIdentity(row.identity, identity) && row.phase === "quarantined") return row.active;
      if (!sameIdentity(row.identity, identity) || !["ready", "draining"].includes(row.phase))
        throw new FleetRefused("uncertain");
      rows[rows.indexOf(row)] = { ...row, phase: "draining" };
      return row.active;
    });
  }
  acknowledgeDrain(identity: SlotIdentity) {
    return this.change((rows) => {
      const row = this.row(rows, identity);
      if (sameIdentity(row.identity, identity) && row.phase === "quarantined") return;
      if (!sameIdentity(row.identity, identity) || row.phase !== "draining")
        throw new FleetRefused("uncertain");
      rows[rows.indexOf(row)] = { ...row, drainAcknowledged: true };
    });
  }
  beginRetirement(identity: SlotIdentity) {
    return this.change((rows) => {
      const row = this.row(rows, identity);
      if (!sameIdentity(row.identity, identity) || row.phase !== "draining" || row.active !== 0)
        throw new FleetRefused("draining");
      rows[rows.indexOf(row)] = { ...row, phase: "retiring" };
    });
  }
  retired(identity: SlotIdentity, end?: RuntimeEnd) {
    return this.change(async (rows, transaction) => {
      const row = this.row(rows, identity);
      if (!sameIdentity(row.identity, identity) || row.phase !== "retiring" || row.active !== 0)
        throw new FleetRefused("draining");
      await transaction.put(retiredKey(row.target.slotId), {
        ...row,
        phase: "retired",
        ...(end ? { end } : {}),
      });
      await this.keepEnd(transaction, row, end);
      rows.splice(rows.indexOf(row), 1);
    });
  }
}
