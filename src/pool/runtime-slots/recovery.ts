import { Schema } from "effect";
import { RuntimeEnd, readEnd } from "./container-end.ts";
import {
  AdmissionProof,
  StartupWitness,
  decodeAdmissionProof,
  runtimeAttestationFormat,
} from "./admission-proof.ts";
import {
  SlotIdentity,
  SlotRefused,
  awaitsProof,
  sameIdentity,
  sameTarget,
  type ControllerCode,
  type SlotSnapshot,
} from "./contract.ts";
import {
  healthy,
  currentPolicies,
  retiredDenials,
  proveSlot,
  slotClock,
  vetoLease,
} from "./proof.ts";
import { slotSelectionKey, type RuntimeSlotStorage, type SlotStorage } from "./storage.ts";
import type { BoundSlotDriver } from "./transport.ts";
import { ProviderCredentialRefused, type RuntimeProviderReader } from "../runtime-provider/read.ts";
import { providerDigest } from "../runtime-provider/canonical.ts";
import { signEnvelope } from "../token.ts";
import { membershipTtlMs } from "../membership-contract.ts";
import { awaitProbe } from "../availability.ts";
import { RuntimeForcedRestart } from "./forced-restart.ts";
import { recoveryWarmMs, restartStartBoundMs } from "./forced-restart-timing.ts";
import type { UnservingState } from "./unserving-clock.ts";

const completionKey = "runtime-slots-v1:recovery-completion";
/**
 * How the primary a recovery replaced had ended, kept by the commit that ends its recovery, where
 * the controller inspect reads it; the completion record is cleared once that recovery finishes.
 */
const primaryEndKey = "runtime-slots-v1:primary-last-end";
const Completion = Schema.Struct({ identity: SlotIdentity, fingerprint: Schema.String });
const Retained = Schema.Struct({
  authorization: AdmissionProof,
  identity: Schema.optional(SlotIdentity),
  witness: Schema.optional(StartupWitness),
  running: Schema.Boolean,
  // Read with `readEnd`: an end this code can't read is dropped, never a failed recovery.
  end: Schema.optional(Schema.Unknown),
});
const PrimaryEnd = Schema.Struct({ previous: SlotIdentity, end: RuntimeEnd });
const isPrimaryEnd = Schema.is(PrimaryEnd);
/** How the last primary a recovery restarted had ended, for the controller inspect. */
export async function primaryLastEnd(storage: { get(key: string): Promise<unknown> }) {
  const value = await storage.get(primaryEndKey);
  return isPrimaryEnd(value) ? value : null;
}
/**
 * A boot's own end is the first one recovery reads for it. A restart attempt that ends before it
 * serves ends a container too, and must not replace it: the record keeps the boot's end until a
 * later boot ends in its turn.
 */
async function keepFirstEnd(transaction: SlotStorage, previous: SlotIdentity, end: unknown) {
  const ended = readEnd(end);
  if (!ended) return;
  const kept = await transaction.get(primaryEndKey);
  if (isPrimaryEnd(kept) && sameIdentity(kept.previous, previous)) return;
  await transaction.put(primaryEndKey, { previous, end: ended });
}
interface Dependencies {
  storage: RuntimeSlotStorage;
  driver: BoundSlotDriver;
  provider: RuntimeProviderReader;
  code: ControllerCode;
  key: string;
  beforeCommit?(
    previous: SlotIdentity,
    next: SlotIdentity,
    transaction: SlotStorage,
  ): Promise<void>;
  afterCommit?(identity: SlotIdentity, fingerprint: string): Promise<void>;
}
export const runtimeRecoveryBudgetMs = 200_000;

/** Reconstructible per-boot recovery joins the endpoint's durable launch witness before changing selection. */
export class RuntimeSlotRecovery {
  private deps: Dependencies;
  private pending?: Promise<void>;
  private unavailable = false;
  /** When the outage this recovery is restoring was detected; unset while nothing is restored. */
  private outage?: number;
  /** A pass found nothing it can do until a person acts; it ends once a pass starts the root. */
  private stalled = false;
  private forced: RuntimeForcedRestart;
  constructor(deps: Dependencies) {
    this.deps = deps;
    this.forced = new RuntimeForcedRestart(deps.storage, deps.driver);
  }
  available() {
    return !this.unavailable;
  }
  /**
   * What is left of the restart start bound since the outage was detected, on the clock the
   * recovery stamps its phases with; 0 once the root serves, recovery stands down or stalls, or the
   * bound has passed. A call may wait this long for the restart instead of failing on its refusals.
   */
  holdMs() {
    return this.outage === undefined || this.stalled
      ? 0
      : Math.max(0, this.outage + restartStartBoundMs - Date.now());
  }
  private restored() {
    this.outage = undefined;
    this.stalled = false;
  }
  /**
   * An outage counts from its first detection since the root served. The clock's own marks of it
   * are durable, so a controller reset mid-recovery never starts the bound again.
   */
  private restoring(clock: UnservingState) {
    const marks = [clock.since, clock.restartedAt, clock.unforcedRestartAt];
    this.outage = Math.min(this.outage ?? Date.now(), ...marks.filter((at) => at !== undefined));
  }
  recover() {
    if (!this.pending) {
      const work = this.run().finally(() => {
        if (this.pending === work) this.pending = undefined;
      });
      this.pending = work;
    }
    return this.pending;
  }
  private async run() {
    const signal = AbortSignal.timeout(runtimeRecoveryBudgetMs);
    await awaitProbe(() => this.runWithin(signal), signal);
  }
  private async finish(identity: SlotIdentity, fingerprint: string, signal: AbortSignal) {
    const before = await this.deps.storage.inspect();
    if (
      !sameIdentity(before.selection?.active.identity, identity) ||
      before.selection?.active.fenced ||
      before.selection?.active.retirement
    )
      throw new SlotRefused("selection");
    await this.deps.afterCommit?.(identity, fingerprint);
    const current = await this.deps.storage.inspect();
    if (!sameIdentity(current.selection?.active.identity, identity))
      throw new SlotRefused("selection");
    currentPolicies(current, slotClock);
    await proveSlot(this.deps.driver, identity, current, slotClock);
    await this.deps.storage.transact(async (latest, transaction) => {
      signal.throwIfAborted();
      if (
        !sameIdentity(latest.selection?.active.identity, identity) ||
        latest.digest !== current.digest
      )
        throw new SlotRefused("selection");
      currentPolicies(latest, slotClock);
      await transaction.put(completionKey, null);
    });
    this.unavailable = false;
    this.restored();
    // The restart served: it is not a failed restart, whenever the next refusal comes.
    await this.forced.clock.serving();
    console.info("POOL_SELECTED_RECOVERY", {
      phase: "ready",
      at: Date.now(),
      slot: identity.slotId,
    });
  }
  /** A boot handed back by an unfence that answers again serves once current policies reach it. */
  private async proveHandedBack(identity: SlotIdentity, snapshot: SlotSnapshot) {
    await proveSlot(this.deps.driver, identity, snapshot, slotClock);
    await this.deps.storage.transact(async (current, transaction) => {
      const selection = current.selection;
      if (!selection || !awaitsProof(selection.active)) return;
      if (!sameIdentity(selection.active.identity, identity) || current.digest !== snapshot.digest)
        throw new SlotRefused("selection");
      const unfenced = selection.active.unfenced!;
      await transaction.put(slotSelectionKey, {
        ...selection,
        active: { ...selection.active, unfenced: { ...unfenced, proven: true } },
      });
    });
  }
  private async runWithin(signal: AbortSignal) {
    const { storage, driver, provider, code, key } = this.deps;
    const completion = await storage.transact(async (_, transaction) =>
      transaction.get(completionKey),
    );
    if (completion != null) {
      this.unavailable = true;
      // A committed restart, forced or not, that never reaches ready must end in needs-a-person,
      // whichever step of this branch keeps failing.
      this.restoring(await this.forced.refused());
      const value = Schema.decodeUnknownSync(Completion)(completion);
      const current = await storage.inspect();
      if (
        !sameIdentity(current.selection?.active.identity, value.identity) ||
        current.selection?.active.fenced ||
        current.selection?.active.retirement
      ) {
        this.restored();
        throw new SlotRefused("selection");
      }
      const actual = Schema.decodeUnknownSync(Retained)(
        await driver.recoveryWitness(value.identity),
      );
      if (!sameIdentity(actual.identity, value.identity)) throw new SlotRefused("identity");
      if (actual.running) {
        await this.finish(value.identity, value.fingerprint, signal);
        return;
      }
      await storage.transact(async (latest, transaction) => {
        if (
          !sameIdentity(latest.selection?.active.identity, value.identity) ||
          JSON.stringify(await transaction.get(completionKey)) !== JSON.stringify(completion)
        )
          throw new SlotRefused("selection");
        await transaction.put(completionKey, null);
      });
    }
    const snapshot = await storage.inspect();
    const selection = snapshot.selection;
    const previous = selection?.active.identity;
    if (
      !selection ||
      !previous ||
      selection.active.fenced ||
      selection.active.retirement ||
      selection.candidate ||
      selection.draining
    ) {
      // Nothing selected, or a state recovery never fights: no restart runs for a call to wait on.
      this.restored();
      if (!selection) return;
      throw new SlotRefused("selection");
    }
    let refusal: unknown;
    try {
      await driver.warm(previous, AbortSignal.any([signal, AbortSignal.timeout(recoveryWarmMs)]));
      if (awaitsProof(selection.active)) await this.proveHandedBack(previous, snapshot);
      this.unavailable = false;
      this.restored();
      await this.forced.clock.serving();
      return;
    } catch (error) {
      this.unavailable = true;
      refusal = error;
    }
    console.info("POOL_SELECTED_RECOVERY", {
      phase: "detected",
      at: Date.now(),
      slot: previous.slotId,
    });
    this.restoring(await this.forced.refused());
    retiredDenials(snapshot);
    let retained = Schema.decodeUnknownSync(Retained)(await driver.recoveryWitness(previous));
    console.info("POOL_SELECTED_RECOVERY", {
      phase: "witness",
      at: Date.now(),
      slot: previous.slotId,
    });
    // Restart-on-exit alone can't recover a root that runs but refuses.
    const considered = await this.forced.consider(
      { previous, epoch: selection.epoch, digest: snapshot.digest, refusal, retained },
      signal,
    );
    if (considered === "stalled") this.stalled = true;
    if (considered === "stopped")
      retained = Schema.decodeUnknownSync(Retained)(await driver.recoveryWitness(previous));
    const original = retained.authorization;
    const operationId = `restart-${(await providerDigest(previous)).slice(0, 48)}`;
    const joining =
      original.kind === "restart" &&
      original.operationId === operationId &&
      sameIdentity(original.previous, previous);
    // A grant for another target fails every pass the same way until a person acts.
    const mismatched = !sameTarget(original.target, previous);
    if (mismatched) this.stalled = true;
    if (
      (!joining && (!sameIdentity(retained.identity, previous) || retained.running)) ||
      mismatched
    )
      throw new SlotRefused("uncertain");
    const selectionProof = {
      expectedEpoch: selection.epoch,
      active: previous,
      policyDigest: snapshot.digest,
      revisions: [
        ...snapshot.policies.map(({ pool, organization, revision }) => ({
          pool,
          organization,
          revision,
          retired: false,
        })),
        ...snapshot.denials.map(({ pool, organization, revision }) => ({
          pool,
          organization,
          revision,
          retired: true,
        })),
      ].sort((a, b) => a.pool.localeCompare(b.pool)),
    };
    const manifestDigest = await providerDigest({
      operationId,
      previous,
      fingerprint: original.configurationFingerprint,
    });
    const application = original.provider;
    const envelope = async (attested: boolean) => {
      console.info("POOL_SELECTED_RECOVERY", {
        phase: attested ? "attesting" : "authorizing",
        at: Date.now(),
        slot: previous.slotId,
      });
      const observation = await provider
        .observe(application, attested ? previous.instanceId : undefined, signal)
        .catch((error: unknown) => {
          // Without a credential the provider accepts, no pass restarts the root until a person acts.
          if (error instanceof ProviderCredentialRefused) this.stalled = true;
          throw error;
        });
      const at = Date.now();
      const witness = attested
        ? Schema.decodeUnknownSync(Retained)(await driver.recoveryWitness(previous)).witness
        : undefined;
      if (
        attested &&
        (!witness?.bootId ||
          witness.operationId !== operationId ||
          witness.manifestDigest !== manifestDigest)
      )
        throw new SlotRefused("identity");
      return signEnvelope(
        key,
        runtimeAttestationFormat,
        decodeAdmissionProof({
          format: runtimeAttestationFormat,
          kind: attested ? "restart-attested" : "restart",
          operationId,
          manifestDigest,
          controllerCode: code,
          target: original.target,
          configurationFingerprint: original.configurationFingerprint,
          selection: selectionProof,
          previous,
          provider: observation,
          at,
          expiresAt: at + 60_000,
          ...(witness ? { bootId: witness.bootId, launch: witness.launch } : {}),
        }),
      );
    };
    // Compare before admission and again at commit; a promotion or policy edit cannot be overwritten.
    await storage.transact(async (current, transaction) => {
      if (
        current.selection?.epoch !== selection.epoch ||
        !sameIdentity(current.selection.active.identity, previous) ||
        current.digest !== snapshot.digest
      )
        throw new SlotRefused("selection");
      retiredDenials(current);
      // Before any restart of this round can end a container of its own.
      await keepFirstEnd(transaction, previous, retained.end);
    });
    if (!retained.running) {
      await driver.admit(previous, await envelope(false));
      // Unless a forced stop began it, this restart is recovery's own, timed from its first admission.
      await this.forced.clock.unforcedRestart(Date.now());
    }
    signal.throwIfAborted();
    // Only a start that can run ends a stall: joining a restart over a container that still runs
    // reaches here too, and its start is refused until the stop a person or the hour must allow.
    if (!retained.running) this.stalled = false;
    console.info("POOL_SELECTED_RECOVERY", {
      phase: "starting",
      at: Date.now(),
      slot: previous.slotId,
    });
    const health = await driver.start(previous, signal);
    if (health.identity.bootId === previous.bootId) throw new SlotRefused("identity");
    const ready = await storage.inspect();
    retiredDenials(ready);
    if (ready.digest !== snapshot.digest) throw new SlotRefused("policy");
    // Expired positives stay absent on a fresh boot. Home renews them before recovery reports ready.
    await Promise.all(
      [
        ...ready.policies
          .filter((policy) => policy.dirty || policy.expiresAt > Date.now())
          .map((policy) => vetoLease(policy, Date.now())),
        ...ready.denials.map((policy) => ({ ...policy, expiresAt: Date.now() + membershipTtlMs })),
      ].map((policy) => driver.install(health.identity, policy, signal)),
    );
    healthy(await driver.health(health.identity, signal), health.identity, slotClock);
    await driver.attest(previous, await envelope(true));
    await driver.ready(health.identity, original.configurationFingerprint, previous.imageInput);
    await storage.transact(async (current, transaction) => {
      if (
        current.selection?.epoch !== selection.epoch ||
        !sameIdentity(current.selection.active.identity, previous) ||
        current.digest !== snapshot.digest ||
        current.selection.active.fenced ||
        current.selection.active.retirement ||
        current.selection.candidate ||
        current.selection.draining
      )
        throw new SlotRefused("selection");
      retiredDenials(current);
      signal.throwIfAborted();
      await this.deps.beforeCommit?.(previous, health.identity, transaction);
      await transaction.put(slotSelectionKey, {
        ...selection,
        epoch: selection.epoch + 1,
        // The new boot holds no grant from before a fence: it took every unexpired policy above,
        // and an expired one reaches it only through Home. So a handed-back slot is proven.
        active: {
          ...selection.active,
          identity: health.identity,
          ...(selection.active.unfenced
            ? { unfenced: { ...selection.active.unfenced, proven: true } }
            : {}),
        },
      });
      await transaction.put(completionKey, {
        identity: health.identity,
        fingerprint: original.configurationFingerprint,
      });
      await keepFirstEnd(transaction, previous, retained.end);
    });
    await this.finish(health.identity, original.configurationFingerprint, signal);
  }
}
