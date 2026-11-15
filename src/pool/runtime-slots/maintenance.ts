import { poolLifecycle, type PoolStatus } from "../lifecycle.ts";
import { RuntimeRetirementTrace } from "../runtime-retirement-trace.ts";
import { SlotRefused, sameIdentity, type SlotIdentity, type SlotTarget } from "./contract.ts";
import type { RuntimeState } from "./runtime-state.ts";
import type { RuntimeChannel } from "./channel.ts";
import type { RuntimeRetirementMonitor } from "./retirement-observation.ts";
import type { RuntimeWitnessStore, WitnessRecord } from "./witness-store.ts";
import type { RuntimeActivity } from "./activity.ts";

interface Dependencies {
  ctx: RuntimeState;
  store: RuntimeWitnessStore;
  channel: RuntimeChannel;
  monitor: RuntimeRetirementMonitor;
  activity: RuntimeActivity;
  bound(target: SlotTarget): void;
  checked(record: WitnessRecord, status: PoolStatus): unknown;
}

/** Upkeep can preserve an admitted process or prove it stopped; it never starts compute. */
export class RuntimeMaintenance {
  private deps: Dependencies;
  constructor(deps: Dependencies) {
    this.deps = deps;
  }
  async alarm() {
    const { ctx, store, channel } = this.deps;
    const target = await store.alarmTarget();
    if (!target || !ctx.container?.running) return;
    this.deps.bound(target);
    const { record, configuration } = await store.read(target);
    try {
      if (record.identity) await this.deps.activity.reconcile(record.identity);
      const health = await channel.health(configuration, AbortSignal.timeout(2_000));
      this.deps.checked(record, health);
      await channel.keepAlive();
    } finally {
      if (ctx.container.running) await ctx.storage.setAlarm(Date.now() + poolLifecycle.refreshMs);
    }
  }
  async failed(identity: SlotIdentity, signal: AbortSignal) {
    const { ctx, store, monitor } = this.deps;
    this.deps.bound(identity);
    const record = await store.retained(identity.slotId);
    if (!record || !sameIdentity(record.identity, identity)) throw new SlotRefused("identity");
    signal.throwIfAborted();
    await monitor.stopped(identity, new RuntimeRetirementTrace("endpoint", 0), signal);
    signal.throwIfAborted();
    if (ctx.container!.running) return { identity, stopped: false };
    // Retain interrupted activity as unknown; only the dead compute identity is retired.
    await store.put(identity, { ...record, retired: true, failed: true });
    return { identity, stopped: true };
  }
}
