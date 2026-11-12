import type { NativeStreamLease } from "../native-streams.ts";
import type { NativeMembershipPolicy } from "../membership-contract.ts";
import {
  sameIdentity,
  sameTarget,
  type SlotIdentity,
  type SlotTarget,
} from "../runtime-slots/contract.ts";
import { FleetRefused, RuntimeFleetState } from "./state.ts";
import { FleetDispatches } from "./dispatches.ts";

export interface FleetCell {
  start(target: SlotTarget): Promise<SlotIdentity>;
  observe(target: SlotTarget): Promise<SlotIdentity | undefined>;
  selected(): Promise<SlotIdentity | undefined>;
  forward(
    request: Request,
    port: 8317,
    pool: string | undefined,
    beforeDispatch: () => void,
  ): Promise<Response>;
  install(policy: NativeMembershipPolicy): Promise<void>;
  abortPool(pool: string): void;
  drain(identity: SlotIdentity): Promise<{ active: number; known: boolean }>;
  retire(identity: SlotIdentity, begin: () => Promise<void>): Promise<void>;
  retired(identity: SlotIdentity): Promise<boolean>;
}
interface Dependencies {
  state: RuntimeFleetState;
  target(occupied: readonly SlotTarget[]): Promise<SlotTarget>;
  cell(target: SlotTarget): FleetCell;
  legacyActive(): Promise<number>;
  currentRequests(): number;
  targetActive: number;
  idleMilliseconds: number;
  maximum: number;
  defer(work: Promise<unknown>): void;
  wrap(response: Response, lease: NativeStreamLease): Response;
  now(): number;
  enabled?(): boolean;
  changed?(): void;
  keepReady?(identity: SlotIdentity): Promise<boolean>;
  balancePrimary?: boolean;
  demandAt?(at: number): void;
}

/** The concurrency target triggers growth; it never becomes another fixed inference cap. */
export class RuntimeFleet {
  private deps: Dependencies;
  private growing?: Promise<void>;
  private atCapacity = false;
  private nextGrowthCheck = 0;
  private growthAlarm?: number;
  private cells = new Map<string, { target: SlotTarget; cell: FleetCell }>();
  private dispatches = new FleetDispatches();
  constructor(deps: Dependencies) {
    if (
      !Number.isSafeInteger(deps.targetActive) ||
      deps.targetActive < 1 ||
      !Number.isSafeInteger(deps.idleMilliseconds) ||
      deps.idleMilliseconds < 1 ||
      !Number.isSafeInteger(deps.maximum) ||
      deps.maximum < 1 ||
      deps.maximum > 4
    )
      throw new Error("Invalid runtime fleet policy");
    this.deps = deps;
  }
  refreshPolicy() {
    this.atCapacity = false;
    this.nextGrowthCheck = 0;
  }
  private cell(target: SlotTarget) {
    const retained = this.cells.get(target.slotId);
    if (retained) {
      if (!sameTarget(retained.target, target)) throw new FleetRefused("identity");
      return retained.cell;
    }
    const cell = this.deps.cell(target);
    this.cells.set(target.slotId, { target, cell });
    return cell;
  }
  private grow() {
    if (this.deps.enabled?.() === false) return;
    if (this.atCapacity) return;
    if (this.deps.now() < this.nextGrowthCheck) {
      if (this.growthAlarm !== this.nextGrowthCheck) {
        this.growthAlarm = this.nextGrowthCheck;
        this.deps.demandAt?.(this.nextGrowthCheck);
      }
      return;
    }
    this.growthAlarm = undefined;
    if (!this.growing) {
      this.nextGrowthCheck = this.deps.now() + 100;
      this.growing = this.addDemandedRuntime().finally(() => {
        this.growing = undefined;
        this.deps.changed?.();
      });
      this.deps.defer(this.growing.catch(() => {}));
    }
  }
  private async addDemandedRuntime() {
    while (true) {
      if (this.deps.enabled?.() === false) return;
      const rows = await this.deps.state.inspect();
      const active = Math.max(
        this.deps.currentRequests(),
        (await this.deps.legacyActive()) + rows.reduce((sum, row) => sum + row.active, 0),
      );
      if (rows.length >= this.deps.maximum) this.atCapacity = true;
      const desired = Math.min(this.deps.maximum, Math.floor(active / this.deps.targetActive));
      if (
        rows.length >= desired ||
        rows.some((row) => row.phase === "reserved" || row.phase === "warming")
      )
        return;
      const target = await this.deps.target(rows.map((row) => row.target));
      await this.deps.state.reserve(target);
      await this.start(target);
    }
  }
  private async start(target: SlotTarget) {
    await this.deps.state.dispatch(target);
    try {
      const identity = await this.cell(target).start(target);
      await this.deps.state.ready(identity);
    } catch (error) {
      await this.deps.state.uncertain(target);
      throw error;
    }
  }
  async forward(
    request: Request,
    pool: string | undefined,
    legacy: () => Promise<Response>,
    beforeDispatch: () => void,
  ) {
    let acquired;
    try {
      acquired = await this.dispatches.acquire(() =>
        this.deps.balancePrimary
          ? this.deps.state.acquire(Number.MAX_SAFE_INTEGER, true)
          : this.deps.state.acquire(Number.MAX_SAFE_INTEGER),
      );
    } catch (error) {
      if (!(error instanceof FleetRefused) || error.reason !== "capacity") throw error;
      // Start legacy admission before reading pressure so the triggering request is counted too.
      const response = legacy();
      this.grow();
      return response;
    }
    const { reservation, dispatched } = acquired;
    this.grow();
    try {
      if (reservation.kind === "primary") {
        const response = await legacy();
        return this.deps.wrap(response, {
          signal: request.signal,
          onClose: () => {},
          release: () => {
            this.deps.defer(reservation.release().then(() => this.deps.changed?.()));
            return true;
          },
        });
      }
      const cell = this.cell(reservation.identity);
      if (!sameIdentity(await cell.selected(), reservation.identity))
        throw new FleetRefused("uncertain");
      const response = await cell.forward(request, 8317, pool, () => {
        beforeDispatch();
        dispatched();
      });
      return this.deps.wrap(response, {
        signal: request.signal,
        onClose: () => {},
        release: () => {
          this.deps.defer(reservation.release().then(() => this.deps.changed?.()));
          return true;
        },
      });
    } catch (error) {
      await reservation.release();
      throw error;
    } finally {
      dispatched();
    }
  }
  async install(policy: NativeMembershipPolicy) {
    const rows = await this.deps.state.inspect();
    await Promise.all(
      rows.map(async (row) => {
        const cell = this.cell(row.target);
        if (await cell.selected()) await cell.install(policy);
      }),
    );
  }
  abortPool(pool: string) {
    for (const { cell } of this.cells.values()) cell.abortPool(pool);
  }
  async drain(identity: SlotIdentity) {
    await this.dispatches.fence(identity, () => this.deps.state.drain(identity));
    const actual = await this.cell(identity).drain(identity);
    await this.deps.state.acknowledgeDrain(identity);
    return actual;
  }
  async upkeep() {
    for (const row of await this.deps.state.inspect()) {
      const cell = this.cell(row.target);
      if (row.phase === "reserved") {
        if (this.deps.enabled?.() === false) {
          await this.deps.state.cancelReserved(row.target);
          this.cells.delete(row.target.slotId);
          continue;
        }
        await this.start(row.target);
      } else if (row.phase === "warming" || row.phase === "uncertain") {
        const observed = await cell.observe(row.target);
        if (observed) await this.deps.state.ready(observed);
      } else if (
        row.phase === "ready" &&
        row.identity &&
        (row.active === 0 || this.deps.enabled?.() === false) &&
        (this.deps.enabled?.() === false || !(await this.deps.keepReady?.(row.identity))) &&
        (this.deps.enabled?.() === false ||
          this.deps.now() - row.lastUsedAt >= this.deps.idleMilliseconds)
      ) {
        await this.drain(row.identity);
      } else if (row.phase === "draining" && row.identity) {
        const actual = await this.drain(row.identity);
        if (row.active !== 0 || actual.active !== 0 || !actual.known) continue;
        const identity = row.identity;
        await cell.retire(identity, () => this.deps.state.beginRetirement(identity));
        this.cells.delete(row.target.slotId);
        await this.deps.state.retired(row.identity);
        this.atCapacity = false;
      } else if (row.phase === "retiring" && row.identity && (await cell.retired(row.identity))) {
        this.cells.delete(row.target.slotId);
        await this.deps.state.retired(row.identity);
        this.atCapacity = false;
      }
    }
    this.grow();
  }
}
