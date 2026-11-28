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
import { cellHealthReadMs, startingBoundMs, type FirstStart } from "./phase-bounds.ts";

interface Dependencies {
  handoff: RuntimeHandoff;
  driver: BoundSlotDriver;
  admission: FleetAdmission;
  application: RuntimeProviderTarget;
  provider: RuntimeProviderReader;
  /** The instances the fleet ledger counts, read afresh for each release. */
  counted(): Promise<ReadonlySet<string>>;
}

/** A fleet cell reuses slot startup, policy installation and body lifetime rather than adding a second execution path. */
export class FleetHandoffCell implements FleetCell {
  /** How each cell's container ended, as its last retirement or failure read said. */
  private ends = new Map<string, RuntimeEnd>();
  private deps: Dependencies;
  private retirementAttempts = 0;
  private starting?: { target: SlotTarget; work: Promise<SlotIdentity> };
  // Activations still returning here, an observed start's included.
  private activating = 0;
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
    this.activating++;
    try {
      await this.deps.handoff.activateInitial(
        await this.deps.admission.envelope(target, "initial-attested"),
      );
      const selected = await this.selected();
      if (!selected || !sameTarget(selected, target)) throw new SlotRefused("identity");
      return selected;
    } finally {
      this.activating--;
    }
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
  /**
   * True when no start can have reached a container: none is under way and no first-start intent
   * exists, which commits before any compute start is sent. From then on this cell starts nothing
   * more, so a pass that read the row before it left can't send the start given up here.
   */
  async unsent() {
    if (this.starting) return false;
    let initial;
    try {
      initial = await this.deps.handoff.slots.firstStart.inspect();
    } catch {
      // An unreadable intent proves nothing, so the start is treated as one that may have run.
      return false;
    }
    if (initial !== undefined || this.starting) return false;
    this.abandoned = true;
    return true;
  }
  async healthy(identity: SlotIdentity) {
    const health = await this.deps.driver.health(identity, AbortSignal.timeout(cellHealthReadMs));
    if (!sameIdentity(health.identity, identity)) throw new SlotRefused("identity");
    return health.database;
  }
  selected() {
    return this.deps.handoff.selected();
  }
  /**
   * How far this cell's first start got, by reads alone; an unreadable one throws. Its intent is
   * marked selected in the selection's own commit, and reads so even once that selection is fenced.
   */
  async firstStart(target: SlotTarget): Promise<FirstStart> {
    if ((await this.deps.handoff.slots.firstStart.inspect())?.selected === true) return "activated";
    return (await this.deps.driver.attested(target, AbortSignal.timeout(2_000)))
      ? "attested"
      : "neither";
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
  checkStill(identity: SlotIdentity) {
    return this.deps.driver.checkStill(identity, AbortSignal.timeout(5_000));
  }
  releaseStill(identity: SlotIdentity, operationId: string) {
    // Its connection read takes up to 1.5 s before the release itself.
    return this.deps.driver.releaseStill(identity, operationId, AbortSignal.timeout(5_000));
  }
  async abandon(target: SlotTarget, stop = false) {
    this.abandoned = true;
    // A start or activation still returning here owns the instance.
    if (this.starting || this.activating > 0) return this.present();
    // A start that activated is fenced but never asked to stop. The ledger never makes a quarantined
    // row ready, so it takes no call, and the fence ends its endpoint's renewals, so its container
    // stops at its inactivity timeout and its place frees once that container is gone. A selection
    // can still commit after this read, from another isolate's activation or one this cell observes
    // later, and its container may then be stopped. That selection serves nothing: the endpoint
    // fences in its serialized section, then refuses every later attestation, read and call.
    const activated = await this.activated();
    // The endpoint is fenced first, so it refuses every later admission and start for this slot and
    // the wait below covers every start that could ever run, a replaced isolate's included. With
    // `stop`, the endpoint then stops the container a start that never activated left running.
    const fenced = await this.fence(target, stop && !activated);
    if (activated)
      return (await this.ended(target)) ? this.provenAbsent(target, true) : this.present();
    if (!fenced) return this.present();
    const initial = await this.deps.handoff.slots.firstStart.inspect();
    // The durable first-start intent commits before the compute start is sent, and the endpoint
    // starts a container only on that send, so its absence proves nothing was ever sent.
    if (!initial) return true;
    if (!sameTarget(initial.target, target)) return false;
    // A destroyed instance stays listed as inactive. That counts as absent only once the fenced
    // endpoint, which can start nothing more, reports its container stopped.
    return this.provenAbsent(target, fenced.stopped);
  }
  /**
   * Whether an activated start's container has stopped, by a read that neither fences nor stops
   * it. Nothing can start that boot's container again: its endpoint record holds the boot, so a
   * start only reads its health, a fleet cell runs no recovery, and this cell starts nothing more.
   */
  private async ended(target: SlotTarget) {
    const selected = await this.selected().catch(() => undefined);
    if (!selected || !sameTarget(selected, target)) return false;
    const actual = await this.deps.driver
      .retirement(selected, AbortSignal.timeout(2_000))
      .catch(() => undefined);
    return actual !== undefined && !actual.running && sameIdentity(actual.identity, selected);
  }
  private async provenAbsent(target: SlotTarget, driverStopped: boolean) {
    if (
      !(await this.deps.provider.absent(this.deps.application, target.instanceId, undefined, {
        ...(driverStopped ? { driverStopped: true as const } : {}),
        counted: await this.deps.counted(),
      }))
    )
      return this.present();
    // A listing can lag a start that was just sent, from this isolate or a replaced one, so an
    // absence counts only once every read for a whole start bound agreed.
    const now = Date.now();
    this.absentSince ??= now;
    return now - this.absentSince >= startingBoundMs;
  }
  private async activated() {
    const initial = await this.deps.handoff.slots.firstStart.inspect();
    if (initial?.selected === true) return true;
    // A selection that can't be read is still a selection.
    return this.selected().then(
      (selected) => selected !== undefined,
      () => true,
    );
  }
  private async fence(target: SlotTarget, stop: boolean) {
    try {
      return await this.deps.driver.abandonStart(target, AbortSignal.timeout(2_000), stop);
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
    await trace.run("provider_observe", async () =>
      this.deps.provider.retiring(
        this.deps.application,
        identity.instanceId,
        await this.deps.counted(),
      ),
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
      await this.deps.provider.retiring(
        this.deps.application,
        identity.instanceId,
        await this.deps.counted(),
      );
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
          async () =>
            this.deps.provider.absent(this.deps.application, identity.instanceId, observation, {
              driverStopped: true,
              counted: await this.deps.counted(),
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
        counted: await this.deps.counted(),
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
