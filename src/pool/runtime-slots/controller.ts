import { Schema } from "effect";
import {
  type PromotionIntent,
  type PromotionReceipt,
  ControllerCode,
  SlotIdentity,
  SlotRefused,
  SlotTarget,
  sameIdentity,
  sameTarget,
  slotKey,
  executionKey,
  type SlotDriver,
  type SlotRecord,
  type SlotSelection,
} from "./contract.ts";
import { currentPolicies, healthy, proveSlot, slotClock, type SlotClock } from "./proof.ts";
import { RuntimeSlotStorage, slotSelectionKey } from "./storage.ts";
import { SlotStreams } from "./streams.ts";
import type { NativeMembershipPolicy } from "../membership-contract.ts";
import { SlotRetirement } from "./retirement.ts";
import { SlotPromotion } from "./promotion.ts";

interface Dependencies {
  controllerId: string;
  controllerCode: ControllerCode;
  storage: RuntimeSlotStorage;
  driver: SlotDriver;
  streams: SlotStreams;
  clock?: SlotClock;
}
/** Inert until a private integration supplies admitted runtime drivers and existing DO storage. */
export class RuntimeSlots {
  private clock: SlotClock;
  private deps: Dependencies;
  readonly retirement: SlotRetirement;
  private promotion: SlotPromotion;
  constructor(deps: Dependencies) {
    this.deps = {
      ...deps,
      controllerCode: Schema.decodeUnknownSync(ControllerCode)(deps.controllerCode),
    };
    this.clock = deps.clock ?? slotClock;
    this.promotion = new SlotPromotion(this.deps, this.clock);
    this.retirement = new SlotRetirement(deps.storage, deps.driver, deps.streams, this.clock);
  }

  async inspect() {
    return { ...(await this.deps.storage.inspect()), controllerCode: this.deps.controllerCode };
  }
  receipt(operationId: string) {
    return this.deps.storage.receipt(operationId);
  }

  async adopt(value: SlotIdentity) {
    const identity = this.identity(value);
    const before = await this.inspect();
    if (before.selection) throw new SlotRefused("selection");
    const health = await proveSlot(this.deps.driver, identity, before, this.clock);
    await this.deps.storage.transact(async (current, transaction) => {
      if (current.selection || current.digest !== before.digest) throw new SlotRefused("selection");
      currentPolicies(current, this.clock);
      currentPolicies(before, this.clock);
      healthy(health, identity, this.clock);
      await transaction.put(slotSelectionKey, {
        epoch: 1,
        active: { target: identity, identity, fenced: false },
      } satisfies SlotSelection);
    });
  }

  async stage(value: SlotTarget) {
    const target = Schema.decodeUnknownSync(SlotTarget)(value);
    if (target.controllerId !== this.deps.controllerId) throw new SlotRefused("identity");
    await this.deps.storage.transact(async (snapshot, transaction) => {
      const { selection } = snapshot;
      if (
        !selection ||
        selection.candidate ||
        selection.draining ||
        selection.active.fenced ||
        target.applicationId === selection.active.target.applicationId ||
        slotKey(target) === slotKey(selection.active.target)
      )
        throw new SlotRefused("selection");
      currentPolicies(snapshot, this.clock);
      await transaction.put(slotSelectionKey, {
        ...selection,
        candidate: { target, fenced: false },
      });
    });
    // Registration precedes startup. Concurrent revocation sees even an unready candidate.
    const health = await this.deps.driver.start(target, AbortSignal.timeout(180_000));
    const identity = this.identity(health.identity);
    if (!sameTarget(identity, target)) throw new SlotRefused("identity");
    healthy(health, identity, this.clock);
    await this.deps.storage.transact(async ({ selection }, transaction) => {
      if (
        !selection?.candidate ||
        !sameTarget(selection.candidate.target, target) ||
        selection.candidate.retirement ||
        selection.candidate.fenced
      )
        throw new SlotRefused("selection");
      await transaction.put(slotSelectionKey, {
        ...selection,
        candidate: { ...selection.candidate, identity },
      });
    });
    const before = await this.inspect();
    const proof = await proveSlot(this.deps.driver, identity, before, this.clock);
    await this.deps.storage.transact(async (current, transaction) => {
      const selection = current.selection;
      if (
        !selection?.candidate ||
        selection.candidate.fenced ||
        selection.candidate.retirement ||
        !sameTarget(selection.candidate.target, target) ||
        current.digest !== before.digest
      )
        throw new SlotRefused("selection");
      currentPolicies(current, this.clock);
      currentPolicies(before, this.clock);
      healthy(proof, identity, this.clock);
      await transaction.put(slotSelectionKey, {
        ...selection,
        candidate: { ...selection.candidate, identity },
      });
    });
    return identity;
  }

  promote(value: PromotionIntent): Promise<PromotionReceipt> {
    return this.promotion.run(value);
  }

  abortPool(pool: string) {
    this.deps.streams.abortPool(pool);
  }

  async observeCandidate() {
    const before = await this.inspect();
    const candidate = before.selection?.candidate;
    if (!candidate || candidate.retirement) throw new SlotRefused("selection");
    const health = await this.deps.driver.observe(candidate.target, AbortSignal.timeout(2_000));
    const identity = this.identity(health.identity);
    if (
      !sameTarget(candidate.target, identity) ||
      (candidate.identity && !sameIdentity(candidate.identity, identity))
    )
      throw new SlotRefused("identity");
    healthy(health, identity, this.clock);
    await this.deps.storage.transact(async ({ selection }, transaction) => {
      const current = selection?.candidate;
      if (
        !selection ||
        !current ||
        current.retirement ||
        !sameTarget(current.target, candidate.target) ||
        (current.identity && !sameIdentity(current.identity, identity))
      )
        throw new SlotRefused("selection");
      await transaction.put(slotSelectionKey, {
        ...selection,
        candidate: { ...current, identity },
      });
    });
    return identity;
  }

  /** NativeMemberships persists dirty state and aborts first, then awaits this fanout. */
  async install(policy: NativeMembershipPolicy) {
    const snapshot = await this.inspect();
    if (!snapshot.selection) throw new SlotRefused("selection");
    const slots = [
      snapshot.selection.active,
      snapshot.selection.candidate,
      snapshot.selection.draining,
    ].filter((slot): slot is SlotRecord => slot !== undefined);
    await Promise.all(
      slots.map(async (slot) => {
        if (slot.fenced) return;
        if (!slot.identity) throw new SlotRefused("uncertain");
        // A failed ACK remains unconfirmed. An explicit fence can resolve it without lying to the writer.
        await this.deps.driver.install(slot.identity, policy, AbortSignal.timeout(2_000));
      }),
    );
    const after = await this.inspect();
    if (JSON.stringify(after.selection) !== JSON.stringify(snapshot.selection))
      throw new SlotRefused("selection");
  }

  async fence(identity: SlotIdentity) {
    this.identity(identity);
    await this.deps.storage.transact(async ({ selection }, transaction) => {
      if (!selection) throw new SlotRefused("selection");
      const roles = ["active", "candidate", "draining"] as const;
      const role = roles.find((role) => sameIdentity(selection[role]?.identity, identity));
      if (!role) throw new SlotRefused("identity");
      await transaction.put(slotSelectionKey, {
        ...selection,
        [role]: { ...selection[role], fenced: true },
      });
    });
    this.deps.streams.abortSlot(executionKey(identity));
  }

  async unfence(identity: SlotIdentity) {
    this.identity(identity);
    const before = await this.inspect();
    const proof = await proveSlot(this.deps.driver, identity, before, this.clock);
    await this.deps.storage.transact(async (snapshot, transaction) => {
      const selection = snapshot.selection;
      if (!selection || snapshot.digest !== before.digest) throw new SlotRefused("selection");
      const role = (["active", "candidate", "draining"] as const).find((role) =>
        sameIdentity(selection[role]?.identity, identity),
      );
      if (!role || selection[role]?.retirement) throw new SlotRefused("selection");
      currentPolicies(snapshot, this.clock);
      currentPolicies(before, this.clock);
      healthy(proof, identity, this.clock);
      await transaction.put(slotSelectionKey, {
        ...selection,
        [role]: { ...selection[role], fenced: false },
      });
    });
  }

  retireDrained(operationId: string) {
    return this.retirement.run("draining", operationId);
  }
  discardCandidate(operationId: string) {
    return this.retirement.run("candidate", operationId);
  }

  private identity(value: SlotIdentity) {
    const identity = Schema.decodeUnknownSync(SlotIdentity)(value);
    if (identity.controllerId !== this.deps.controllerId) throw new SlotRefused("identity");
    return identity;
  }
}
