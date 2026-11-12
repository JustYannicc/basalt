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

interface Dependencies {
  handoff: RuntimeHandoff;
  driver: BoundSlotDriver;
  admission: FleetAdmission;
  application: RuntimeProviderTarget;
  provider: RuntimeProviderReader;
}

/** A fleet cell reuses slot startup, policy installation and body lifetime rather than adding a second execution path. */
export class FleetHandoffCell implements FleetCell {
  private deps: Dependencies;
  constructor(deps: Dependencies) {
    this.deps = deps;
  }
  async start(target: SlotTarget) {
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
  async retire(identity: SlotIdentity, begin: () => Promise<void>) {
    await this.deps.provider.observe(this.deps.application, identity.instanceId);
    await begin();
    await this.deps.driver.retire(identity, identity, AbortSignal.timeout(2_000));
    if (!(await this.retired(identity))) throw new SlotRefused("uncertain");
  }
  async retired(identity: SlotIdentity) {
    const actual = await this.deps.driver.retirement(identity, AbortSignal.timeout(2_000));
    if (!sameIdentity(actual.identity, identity) || !actual.retired || actual.running) return false;
    return this.deps.provider.absent(this.deps.application, identity.instanceId);
  }
}
