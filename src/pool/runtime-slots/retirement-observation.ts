import { awaitProbe } from "../availability.ts";
import { RuntimeActivity } from "./activity.ts";
import { SlotRefused, sameIdentity, type SlotIdentity } from "./contract.ts";
import { RuntimeWitnessStore } from "./witness-store.ts";
import type { RuntimeState } from "./runtime-state.ts";
import { RuntimeRetirementTrace } from "../runtime-retirement-trace.ts";

/** Older container runtimes update running only when their monitor settles. */
export class RuntimeRetirementMonitor {
  private container: NonNullable<RuntimeState["container"]>;
  private observation?: Promise<void>;
  private identity?: SlotIdentity;
  constructor(container: NonNullable<RuntimeState["container"]>) {
    this.container = container;
  }
  start(identity: SlotIdentity) {
    if (this.identity && !sameIdentity(this.identity, identity)) this.observation = undefined;
    this.identity = identity;
    if (this.observation || !this.container.running) return;
    try {
      this.observation = this.container.monitor();
    } catch (error) {
      this.observation = Promise.reject(error);
    }
    // Destruction may outlive its caller; retain one handled observation for later reports.
    void this.observation.catch(() => {});
  }
  async stopped(identity: SlotIdentity, trace: RuntimeRetirementTrace, caller?: AbortSignal) {
    if (this.identity && !sameIdentity(this.identity, identity)) this.observation = undefined;
    if (!this.observation && !this.container.running) return;
    const signal = AbortSignal.any([AbortSignal.timeout(2_000), ...(caller ? [caller] : [])]);
    signal.throwIfAborted();
    this.start(identity);
    const observation = this.observation;
    if (!observation) return;
    await trace.run(
      "monitor",
      () => awaitProbe(() => observation, signal),
      () => ({ running: this.container.running }),
      signal,
    );
    if (this.container.running) throw new SlotRefused("uncertain");
  }
}

/** A stopped runtime plus its retained zero-activity intent recovers a lost destroy acknowledgement. */
export async function observeRuntimeRetirement(
  identity: SlotIdentity,
  container: NonNullable<RuntimeState["container"]>,
  store: RuntimeWitnessStore,
  activity: RuntimeActivity,
  trace: RuntimeRetirementTrace,
  monitor: RuntimeRetirementMonitor,
  signal?: AbortSignal,
) {
  const record = await trace.run(
    "witness_read",
    () => store.retained(identity.slotId),
    undefined,
    signal,
  );
  if (!record || !sameIdentity(record.identity, identity)) throw new SlotRefused("identity");
  let retired = record.retired === true;
  let intent = false;
  if (!retired) {
    const retained = await trace.run(
      "activity_read",
      () => activity.inspect(identity),
      undefined,
      signal,
    );
    intent = retained?.phase === "retiring" && retained.known && retained.active === 0;
  }
  if (retired || intent) {
    monitor.start(identity);
    if (!retired && container.running) return { identity, retired: false, running: true };
    await monitor.stopped(identity, trace, signal);
    if (!retired) {
      await trace.run(
        "retired_record",
        () => store.put(identity, { ...record, retired: true }),
        () => ({ recovered: true }),
        signal,
      );
      retired = true;
    }
  }
  return { identity, retired, running: container.running };
}
