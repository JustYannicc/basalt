import { Schema } from "effect";
import {
  SlotIdentity,
  SlotTarget,
  SlotRefused,
  sameIdentity,
  sameTarget,
  type SlotDriver,
} from "./contract.ts";
import { RuntimeSlotStorage, slotSelectionKey, slotFirstStartKey } from "./storage.ts";
import { currentPolicies, healthy, proveSlot, type SlotClock } from "./proof.ts";

const key = slotFirstStartKey;
const Initial = Schema.Struct({
  target: SlotTarget,
  identity: Schema.optional(SlotIdentity),
  selected: Schema.Boolean,
});
interface Dependencies {
  controllerId: string;
  storage: RuntimeSlotStorage;
  driver: SlotDriver;
}

/** An independent cell has no old runtime to adopt. First start is fenced separately from replacement. */
export class SlotFirstStart {
  private deps: Dependencies;
  private clock: SlotClock;
  constructor(deps: Dependencies, clock: SlotClock) {
    this.deps = deps;
    this.clock = clock;
  }
  inspect() {
    return this.deps.storage.transact(async (_, transaction) => {
      const value = await transaction.get(key);
      return value === undefined ? undefined : Schema.decodeUnknownSync(Initial)(value);
    });
  }
  async start(value: SlotTarget, expectedPolicyDigest: string) {
    const target = Schema.decodeUnknownSync(SlotTarget)(value);
    if (target.controllerId !== this.deps.controllerId || target.homePeerOrdinal === undefined)
      throw new SlotRefused("identity");
    await this.deps.storage.transact(async (snapshot, transaction) => {
      if (snapshot.selection || (await transaction.get(key))) throw new SlotRefused("uncertain");
      if (snapshot.digest !== expectedPolicyDigest) throw new SlotRefused("policy");
      currentPolicies(snapshot, this.clock);
      await transaction.put(key, { target, selected: false } satisfies typeof Initial.Type);
    });
    const proof = await this.deps.driver.start(target, AbortSignal.timeout(180_000));
    if (!sameTarget(proof.identity, target)) throw new SlotRefused("identity");
    healthy(proof, proof.identity, this.clock);
    await this.record(target, proof.identity);
    return proof.identity;
  }
  private record(target: SlotTarget, identity: SlotIdentity) {
    return this.deps.storage.transact(async (snapshot, transaction) => {
      const current = Schema.decodeUnknownSync(Initial)(await transaction.get(key));
      if (
        snapshot.selection ||
        current.selected ||
        !sameTarget(current.target, target) ||
        (current.identity && !sameIdentity(current.identity, identity))
      )
        throw new SlotRefused("identity");
      await transaction.put(key, { ...current, identity });
    });
  }
  async observe() {
    const initial = await this.inspect();
    if (!initial || initial.selected) throw new SlotRefused("selection");
    const proof = await this.deps.driver.observe(initial.target, AbortSignal.timeout(2_000));
    if (!sameTarget(proof.identity, initial.target)) throw new SlotRefused("identity");
    healthy(proof, proof.identity, this.clock);
    await this.record(initial.target, proof.identity);
    return proof.identity;
  }
  async activate(identity: SlotIdentity, expectedPolicyDigest: string, verify: () => void) {
    const initial = await this.inspect();
    const before = await this.deps.storage.inspect();
    if (
      !initial ||
      initial.selected ||
      before.selection ||
      !sameIdentity(initial.identity, identity) ||
      before.digest !== expectedPolicyDigest
    )
      throw new SlotRefused("selection");
    const proof = await proveSlot(this.deps.driver, identity, before, this.clock);
    await this.deps.storage.transact(async (current, transaction) => {
      const retained = Schema.decodeUnknownSync(Initial)(await transaction.get(key));
      if (
        current.selection ||
        retained.selected ||
        !sameIdentity(retained.identity, identity) ||
        current.digest !== expectedPolicyDigest
      )
        throw new SlotRefused("selection");
      verify();
      currentPolicies(before, this.clock);
      currentPolicies(current, this.clock);
      healthy(proof, identity, this.clock);
      await transaction.put(slotSelectionKey, {
        epoch: 1,
        active: { target: identity, identity, fenced: false },
      });
      await transaction.put(key, { ...retained, selected: true });
    });
    return identity;
  }
}
