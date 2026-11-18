import { Schema } from "effect";
import {
  PromotionIntent,
  PromotionReceipt,
  SlotRefused,
  type PromotionRefusal,
  sameIdentity,
  sameIntent,
  sameControllerCode,
  type ControllerCode,
  type SlotDriver,
  type SlotSelection,
  type SlotSnapshot,
} from "./contract.ts";
import { currentPolicies, healthy, proveSlot, type SlotClock } from "./proof.ts";
import { RuntimeSlotStorage, slotSelectionKey, type SlotStorage } from "./storage.ts";

interface Dependencies {
  controllerId: string;
  controllerCode: ControllerCode;
  storage: RuntimeSlotStorage;
  driver: SlotDriver;
  beforePromote?(intent: PromotionIntent, transaction: SlotStorage): Promise<void>;
}
// A fixed vocabulary only: receipts are readable through the handoff receipt command.
const refusalReason = (error: unknown): PromotionRefusal =>
  error instanceof SlotRefused
    ? error.reason
    : error instanceof DOMException && error.name === "TimeoutError"
      ? "timeout"
      : "unclassified";
const revisions = (snapshot: SlotSnapshot) =>
  [...snapshot.policies, ...snapshot.denials]
    .sort((left, right) => left.pool.localeCompare(right.pool))
    .map(({ pool, organization, revision }) => ({ pool, organization, revision }));

/** One intent's durable receipt and selection commit share the controller transaction. */
export class SlotPromotion {
  private deps: Dependencies;
  private clock: SlotClock;
  constructor(deps: Dependencies, clock: SlotClock) {
    this.deps = deps;
    this.clock = clock;
  }
  async run(value: PromotionIntent, verify?: () => void): Promise<PromotionReceipt> {
    const intent = Schema.decodeUnknownSync(PromotionIntent)(value);
    if (!sameControllerCode(intent.controllerCode, this.deps.controllerCode))
      throw new SlotRefused("identity");
    if (
      intent.previous.controllerId !== this.deps.controllerId ||
      intent.candidate.controllerId !== this.deps.controllerId
    )
      throw new SlotRefused("identity");
    const key = this.deps.storage.receiptKey(intent.operationId);
    const started = await this.deps.storage.transact(async (snapshot, transaction) => {
      const prior = await transaction.get<unknown>(key);
      if (prior !== undefined) {
        const receipt = Schema.decodeUnknownSync(PromotionReceipt)(prior);
        if (!sameIntent(receipt.intent, intent)) throw new SlotRefused("identity");
        return { receipt };
      }
      verify?.();
      this.eligible(snapshot, intent);
      const receipt: PromotionReceipt = {
        format: "pool-promotion-receipt-v1",
        intent,
        status: "started",
        at: this.clock.now(),
        epoch: intent.expectedEpoch,
        policies: revisions(snapshot),
      };
      await transaction.put(key, receipt);
      return { receipt, snapshot };
    });
    // A started receipt after eviction is inspection-only, even when no selection changed.
    if (!started.snapshot) return started.receipt;
    let proof: Awaited<ReturnType<typeof proveSlot>>;
    try {
      proof = await proveSlot(this.deps.driver, intent.candidate, started.snapshot, this.clock);
    } catch (error) {
      // No selection write was attempted, so a failed proof is a settled refusal a new attempt can follow.
      return this.refuse(key, refusalReason(error));
    }
    try {
      return await this.deps.storage.transact(async (snapshot, transaction) => {
        verify?.();
        this.eligible(snapshot, intent);
        currentPolicies(started.snapshot!, this.clock);
        healthy(proof, intent.candidate, this.clock);
        const selection = snapshot.selection!;
        const receipt: PromotionReceipt = {
          ...started.receipt,
          status: "promoted",
          epoch: selection.epoch + 1,
        };
        await this.deps.beforePromote?.(intent, transaction);
        await transaction.put(slotSelectionKey, {
          epoch: receipt.epoch,
          active: selection.candidate!,
          draining: selection.active,
        } satisfies SlotSelection);
        await transaction.put(key, receipt);
        return receipt;
      });
    } catch (error) {
      // A failed commit may have succeeded. Never overwrite its durable result.
      const retained = await this.deps.storage.receipt(intent.operationId);
      if (retained?.status === "promoted") return retained;
      if (error instanceof SlotRefused) return this.refuse(key, error.reason);
      throw error;
    }
  }

  private refuse(key: string, reason: PromotionRefusal) {
    return this.deps.storage.transact(async (_, transaction) => {
      const retained = Schema.decodeUnknownSync(PromotionReceipt)(await transaction.get(key));
      if (retained.status !== "started") return retained;
      const refused: PromotionReceipt = { ...retained, status: "refused", reason };
      await transaction.put(key, refused);
      return refused;
    });
  }

  private eligible(snapshot: SlotSnapshot, intent: PromotionIntent) {
    const selection = snapshot.selection;
    if (
      !selection ||
      selection.epoch !== intent.expectedEpoch ||
      selection.draining ||
      selection.active.fenced ||
      selection.candidate?.fenced ||
      selection.candidate?.retirement ||
      !sameIdentity(selection.active.identity, intent.previous) ||
      !sameIdentity(selection.candidate?.identity, intent.candidate)
    )
      throw new SlotRefused("selection");
    if (snapshot.digest !== intent.policyDigest) throw new SlotRefused("policy");
    currentPolicies(snapshot, this.clock);
  }
}
