import { RuntimeRetirementTrace } from "../runtime-retirement-trace.ts";
import { readEnd, type RuntimeEnd } from "../runtime-slots/container-end.ts";
import { awaitProbe } from "../availability.ts";
import {
  SlotRefused,
  sameIdentity,
  sameTarget,
  type SlotIdentity,
  type SlotTarget,
} from "../runtime-slots/contract.ts";
import type { RuntimeHandoff } from "../runtime-slots/integration.ts";
import type { BoundSlotDriver } from "../runtime-slots/transport.ts";
import type { RuntimeProviderReader, RuntimeProviderTarget } from "../runtime-provider/read.ts";
import type { NativeMembershipPolicy } from "../membership-contract.ts";
import type { FleetCell } from "./controller.ts";
import type { FleetAdmission } from "./admission.ts";
import { startingBoundMs } from "./phase-bounds.ts";

interface Dependencies {
  handoff: RuntimeHandoff;
  driver: BoundSlotDriver;
  admission: FleetAdmission;
  application: RuntimeProviderTarget;
  provider: RuntimeProviderReader;
}

/** A fleet cell reuses slot startup, policy installation and body lifetime rather than adding a second execution path. */
export class FleetHandoffCell implements FleetCell {
  /** How each cell's container ended, as its last retirement or failure read said. */
  private ends = new Map<string, RuntimeEnd>();
  private deps: Dependencies;
  private retirementAttempts = 0;
  private starting?: { target: SlotTarget; work: Promise<SlotIdentity> };
  private absentSince?: number;
  // Set before abandon() first yields and checked before start() does, so the two never overlap.
  private abandoned = false;
  constructor(deps: Dependencies) {
    this.deps = deps;
  }
  async start(target: SlotTarget) {
    if (this.abandoned) throw new SlotRefused("selection");
    if (this.starting) {
      if (!sameTarget(this.starting.target, target)) throw new SlotRefused("identity");
      return this.starting.work;
    }
    const work = this.startOwned(target).finally(() => {
      this.starting = undefined;
    });
    this.starting = { target, work };
    return work;
  }
  private async startOwned(target: SlotTarget) {
    await this.deps.handoff.startInitial(
      await this.deps.admission.envelope(target, "initial-start"),
    );
    return this.activate(target);
  }
  private async activate(target: SlotTarget) {
    await this.deps.handoff.activateInitial(
      await this.deps.admission.envelope(target, "initial-attested"),
    );
    const selected = await this.selected();
    if (!selected || !sameTarget(selected, target)) throw new SlotRefused("identity");
    return selected;
  }
  async observe(target: SlotTarget, retryUnsent = false) {
    if (this.starting) {
      if (!sameTarget(this.starting.target, target)) throw new SlotRefused("identity");
      // A recovered activation would invalidate the still-returning start's durable receipt.
      return undefined;
    }
    const selected = await this.selected();
    if (selected) {
      if (!sameTarget(selected, target)) throw new SlotRefused("identity");
      await this.deps.handoff.status();
      return selected;
    }
    const initial = await this.deps.handoff.slots.firstStart.inspect();
    // The durable first-start intent precedes every compute start, so absence proves it was unsent.
    if (!initial) return retryUnsent ? this.start(target) : undefined;
    if (!sameTarget(initial.target, target)) throw new SlotRefused("identity");
    await this.deps.handoff.slots.firstStart.observe();
    return this.activate(target);
  }
  async sent(target: SlotTarget) {
    // A start still under way here may yet write its intent and send.
    if (this.starting) return true;
    try {
      const initial = await this.deps.handoff.slots.firstStart.inspect();
      // The durable first-start intent commits before the compute start is sent.
      return initial !== undefined && sameTarget(initial.target, target);
    } catch {
      // An unreadable intent proves nothing, so the start is treated as one that may have run.
      return true;
    }
  }
  async healthy(identity: SlotIdentity) {
    const health = await this.deps.driver.health(identity, AbortSignal.timeout(2_000));
    if (!sameIdentity(health.identity, identity)) throw new SlotRefused("identity");
    return health.database;
  }
  selected() {
    return this.deps.handoff.selected();
  }
  forward(request: Request, port: 8317, pool: string | undefined, beforeDispatch: () => void) {
    return this.deps.handoff.forward(
      request,
      port,
      pool,
      async () => {
        throw new SlotRefused("selection");
      },
      beforeDispatch,
    );
  }
  install(policy: NativeMembershipPolicy) {
    return this.deps.handoff.slots.install(policy);
  }
  abortPool(pool: string) {
    this.deps.handoff.abortPool(pool);
  }
  drain(identity: SlotIdentity) {
    return this.deps.driver.drain(identity, AbortSignal.timeout(2_000));
  }
  activity(identity: SlotIdentity) {
    return this.deps.driver.activity(identity, AbortSignal.timeout(2_000));
  }
  async abandon(target: SlotTarget) {
    this.abandoned = true;
    // A start still returning here owns the instance.
    if (this.starting) return this.present();
    // The endpoint is fenced first, so it refuses every later admission and start for this slot and
    // the wait below covers every start that could ever run, a replaced isolate's included.
    const fenced = await this.fence(target);
    if (!fenced) return this.present();
    const initial = await this.deps.handoff.slots.firstStart.inspect();
    // The durable first-start intent commits before the compute start is sent, and the endpoint
    // starts a container only on that send, so its absence proves nothing was ever sent.
    if (!initial) return true;
    if (!sameTarget(initial.target, target)) return false;
    // A destroyed instance stays listed as inactive. That counts as absent only once the fenced
    // endpoint, which can start nothing more, reports its container stopped.
    const proven = fenced.stopped ? { driverStopped: true as const } : undefined;
    if (
      !(await this.deps.provider.absent(
        this.deps.application,
        target.instanceId,
        undefined,
        proven,
      ))
    )
      return this.present();
    // A listing can lag a start that was just sent, from this isolate or a replaced one, so an
    // absence counts only once every read for a whole start bound agreed.
    const now = Date.now();
    this.absentSince ??= now;
    return now - this.absentSince >= startingBoundMs;
  }
  private async fence(target: SlotTarget) {
    try {
      return await this.deps.driver.abandonStart(target, AbortSignal.timeout(2_000));
    } catch {
      return undefined;
    }
  }
  private present() {
    this.absentSince = undefined;
    return false;
  }
  async retire(identity: SlotIdentity, begin: () => Promise<void>) {
    const trace = new RuntimeRetirementTrace("cell", ++this.retirementAttempts);
    await trace.run("provider_observe", () =>
      this.deps.provider.observe(this.deps.application, identity.instanceId),
    );
    await begin();
    const signal = AbortSignal.timeout(2_000);
    try {
      await trace.run(
        "driver_retire",
        () => this.deps.driver.retire(identity, identity, signal),
        undefined,
        signal,
      );
    } catch (error) {
      // The stop may outlast this call's budget; one the endpoint reports under way is no failure.
      if (!(await this.stopping(identity))) throw error;
      return false;
    }
    // A stop still under way is picked up by a later pass's retirement read.
    return this.retired(identity);
  }
  private async stopping(identity: SlotIdentity) {
    const actual = await this.deps.driver
      .retirement(identity, AbortSignal.timeout(2_000))
      .catch(() => undefined);
    return actual?.stopping === true && sameIdentity(actual.identity, identity);
  }
  async retired(identity: SlotIdentity, resumeBeforeDispatch = false) {
    const trace = new RuntimeRetirementTrace("cell", ++this.retirementAttempts);
    const signal = AbortSignal.timeout(2_000);
    let actual = await trace.run(
      "driver_retirement",
      () => this.deps.driver.retirement(identity, signal),
      (value) => ({
        retired: value.retired,
        running: value.running,
        identityMatches: sameIdentity(value.identity, identity),
      }),
      signal,
    );
    if (
      resumeBeforeDispatch &&
      sameIdentity(actual.identity, identity) &&
      !actual.retired &&
      actual.retireNotStarted
    ) {
      const drain = await this.drain(identity);
      if (!drain.known || drain.active !== 0) return false;
      await this.deps.provider.observe(this.deps.application, identity.instanceId);
      // Only the child's zero-activity draining state proves the earlier retire never reached its intent.
      // Endpoint serialization and its retiring latch prevent concurrent recoveries from destroying twice.
      await this.deps.driver.retire(identity, identity, AbortSignal.timeout(2_000));
      actual = await this.deps.driver.retirement(identity, AbortSignal.timeout(2_000));
    }
    if (!sameIdentity(actual.identity, identity) || !actual.retired || actual.running) return false;
    const end = readEnd(actual.end);
    if (end) this.ends.set(identity.slotId, end);
    const observation = AbortSignal.timeout(15_000);
    return trace.run(
      "provider_absent",
      () =>
        awaitProbe(
          () =>
            this.deps.provider.absent(this.deps.application, identity.instanceId, observation, {
              driverStopped: true,
            }),
          observation,
        ),
      (absent) => ({ absent }),
      observation,
    );
  }
  lastEnd(identity: SlotIdentity) {
    return this.ends.get(identity.slotId);
  }
  async failed(identity: SlotIdentity, active: number) {
    const signal = AbortSignal.timeout(2_000);
    let actual;
    try {
      actual = await this.deps.driver.failed(identity, signal);
    } catch {
      /* An unreachable or live process still owns its physical capacity. */
    }
    if (actual?.stopped) {
      if (!sameIdentity(actual.identity, identity)) return false;
      const end = readEnd(actual.end);
      if (end) this.ends.set(identity.slotId, end);
      return this.deps.provider.absent(this.deps.application, identity.instanceId, undefined, {
        driverStopped: true,
      });
    }
    if (active !== 0) return false;
    try {
      const drain = await this.drain(identity);
      if (!drain.known || drain.active !== 0) return false;
      // A healthy transport casualty follows the ordinary zero-activity retirement path.
      return await this.retire(identity, async () => {});
    } catch {
      return false;
    }
  }
}
