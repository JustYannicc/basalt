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
import { RuntimeSlotStorage, slotSelectionKey, type SlotStorage } from "./storage.ts";
import { SlotStreams } from "./streams.ts";
import type { NativeMembershipPolicy } from "../membership-contract.ts";
import { PoolRuntimeUnhealthy } from "../lifecycle.ts";
import { SlotRetirement, type RetirementProvider } from "./retirement.ts";
import { SlotPromotion } from "./promotion.ts";
import { SlotFirstStart } from "./first-start.ts";

/**
 * The proof failed because the runtime itself refused: it isn't running, answers unhealthy or as
 * another boot, or doesn't answer in time. A controller-side refusal or a defect is not one.
 */
export function proofRefusedByRuntime(refusal: unknown) {
  if (refusal instanceof SlotRefused)
    return (
      refusal.reason === "unhealthy" ||
      refusal.reason === "identity" ||
      refusal.reason === "uncertain"
    );
  return (
    refusal instanceof PoolRuntimeUnhealthy ||
    (refusal instanceof DOMException && refusal.name === "TimeoutError")
  );
}

interface Dependencies {
  controllerId: string;
  controllerCode: ControllerCode;
  storage: RuntimeSlotStorage;
  driver: SlotDriver;
  streams: SlotStreams;
  clock?: SlotClock;
  beforeStage?(target: SlotTarget, transaction: SlotStorage): Promise<void>;
  beforePromote?(intent: PromotionIntent, transaction: SlotStorage): Promise<void>;
  retirementProvider?: RetirementProvider;
}
/** Inert until a private integration supplies admitted runtime drivers and existing DO storage. */
export class RuntimeSlots {
  private clock: SlotClock;
  private deps: Dependencies;
  readonly retirement: SlotRetirement;
  readonly firstStart: SlotFirstStart;
  private promotion: SlotPromotion;
  constructor(deps: Dependencies) {
    this.deps = {
      ...deps,
      controllerCode: Schema.decodeUnknownSync(ControllerCode)(deps.controllerCode),
    };
    this.clock = deps.clock ?? slotClock;
    this.promotion = new SlotPromotion(this.deps, this.clock);
    this.retirement = new SlotRetirement(
      deps.storage,
      deps.driver,
      deps.streams,
      this.clock,
      deps.retirementProvider,
    );
    this.firstStart = new SlotFirstStart(deps, this.clock);
  }

  async inspect() {
    return { ...(await this.deps.storage.inspect()), controllerCode: this.deps.controllerCode };
  }
  receipt(operationId: string) {
    return this.deps.storage.receipt(operationId);
  }

  async adopt(value: SlotIdentity, expectedPolicyDigest?: string) {
    const identity = this.identity(value);
    const before = await this.inspect();
    if (before.selection) throw new SlotRefused("selection");
    if (expectedPolicyDigest !== undefined && before.digest !== expectedPolicyDigest)
      throw new SlotRefused("policy");
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

  async prepareStage(
    value: SlotTarget,
    expected?: { epoch: number; active: SlotIdentity; digest: string },
    prepared?: (transaction: SlotStorage) => Promise<void>,
  ) {
    const target = Schema.decodeUnknownSync(SlotTarget)(value);
    if (target.controllerId !== this.deps.controllerId) throw new SlotRefused("identity");
    await this.deps.storage.transact(async (snapshot, transaction) => {
      const { selection } = snapshot;
      if (
        expected &&
        (selection?.epoch !== expected.epoch ||
          snapshot.digest !== expected.digest ||
          !sameIdentity(selection?.active.identity, expected.active))
      )
        throw new SlotRefused("selection");
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
      await prepared?.(transaction);
      await this.deps.beforeStage?.(target, transaction);
      await transaction.put(slotSelectionKey, {
        ...selection,
        candidate: { target, fenced: false },
      });
    });
    return target;
  }

  async stage(
    value: SlotTarget,
    expected?: { epoch: number; active: SlotIdentity; digest: string },
    admit?: () => Promise<void>,
  ) {
    const target = await this.prepareStage(value, expected);
    await admit?.();
    return this.startStage(target, AbortSignal.timeout(180_000));
  }

  async startStage(target: SlotTarget, signal: AbortSignal) {
    const beforeStart = await this.inspect();
    if (
      !beforeStart.selection?.candidate ||
      !sameTarget(beforeStart.selection.candidate.target, target) ||
      beforeStart.selection?.candidate?.fenced ||
      beforeStart.selection?.candidate?.retirement
    )
      throw new SlotRefused("selection");
    // Registration precedes startup. Concurrent revocation sees even an unready candidate.
    const health = await this.deps.driver.start(target, signal);
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
    return this.verifyCandidate(identity);
  }

  async verifyCandidate(identity: SlotIdentity) {
    const target = identity;
    const before = await this.inspect();
    const proof = await proveSlot(this.deps.driver, identity, before, this.clock);
    await this.deps.storage.transact(async (current, transaction) => {
      const selection = current.selection;
      if (
        !selection?.candidate ||
        selection.candidate.fenced ||
        selection.candidate.retirement ||
        !sameTarget(selection.candidate.target, target) ||
        !sameIdentity(selection.candidate.identity, identity) ||
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

  promote(value: PromotionIntent, verify?: () => void): Promise<PromotionReceipt> {
    return this.promotion.run(value, verify);
  }

  abortPool(pool: string) {
    this.deps.streams.abortPool(pool);
  }

  async observeCandidate() {
    const before = await this.inspect();
    const candidate = before.selection?.candidate;
    if (!candidate || candidate.retirement || candidate.fenced) throw new SlotRefused("selection");
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
        current.fenced ||
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
        [role]: {
          ...selection[role],
          fenced: true,
          fencedAt: this.clock.now(),
          unfenced: undefined,
        },
      });
    });
    this.deps.streams.abortSlot(executionKey(identity));
  }

  /**
   * Ends a fence. A slot that proves its health and takes current policies serves at once. An active
   * slot that can't goes back to recovery instead, unproven: nothing routes to it until current
   * policies reach its boot, by recovery's restart or its proof. A fenced boot may still hold clean
   * grants from before its fence for the plugin's 24-hour grace, so the gate, not time, is the guard.
   */
  async unfence(identity: SlotIdentity): Promise<{ by: "proof" | "recovery" }> {
    this.identity(identity);
    const before = await this.inspect();
    let proof: Awaited<ReturnType<typeof proveSlot>>;
    try {
      proof = await proveSlot(this.deps.driver, identity, before, this.clock);
    } catch (refusal) {
      // Only a runtime that isn't serving goes back to recovery; a policy or selection refusal, or a
      // defect, stays an error for the operator.
      if (!proofRefusedByRuntime(refusal) || !(await this.returnToRecovery(identity)))
        throw refusal;
      return { by: "recovery" };
    }
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
        [role]: {
          ...selection[role],
          fenced: false,
          unfenced: { by: "proof", at: this.clock.now(), proven: true },
        },
      });
    });
    return { by: "proof" };
  }
  /** Unfences the active slot unproven, for recovery; false when that isn't this slot's case. */
  private returnToRecovery(identity: SlotIdentity) {
    const now = this.clock.now();
    return this.deps.storage.transact(async ({ selection }, transaction) => {
      const active = selection?.active;
      // Recovery acts on the active slot alone; a fenced candidate or draining slot needs its proof.
      if (
        !selection ||
        !active?.fenced ||
        !sameIdentity(active.identity, identity) ||
        active.retirement
      )
        return false;
      await transaction.put(slotSelectionKey, {
        ...selection,
        active: { ...active, fenced: false, unfenced: { by: "recovery", at: now, proven: false } },
      });
      return true;
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
