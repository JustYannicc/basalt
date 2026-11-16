import { Schema } from "effect";
import {
  AdmissionProof,
  StartupWitness,
  decodeAdmissionProof,
  runtimeAttestationFormat,
} from "./admission-proof.ts";
import {
  SlotIdentity,
  SlotRefused,
  sameIdentity,
  sameTarget,
  type ControllerCode,
} from "./contract.ts";
import { healthy, currentPolicies, proveSlot, slotClock } from "./proof.ts";
import { slotSelectionKey, type RuntimeSlotStorage, type SlotStorage } from "./storage.ts";
import type { BoundSlotDriver } from "./transport.ts";
import type { RuntimeProviderReader } from "../runtime-provider/read.ts";
import { providerDigest } from "../runtime-provider/canonical.ts";
import { signEnvelope } from "../token.ts";
import { membershipTtlMs } from "../membership-contract.ts";
import type { SlotSnapshot } from "./contract.ts";
import { awaitProbe } from "../availability.ts";

const completionKey = "runtime-slots-v1:recovery-completion";
const Completion = Schema.Struct({ identity: SlotIdentity, fingerprint: Schema.String });
const Retained = Schema.Struct({
  authorization: AdmissionProof,
  identity: Schema.optional(SlotIdentity),
  witness: Schema.optional(StartupWitness),
  running: Schema.Boolean,
});
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
function clean(snapshot: SlotSnapshot) {
  if (
    snapshot.policies.some((policy) => policy.dirty) ||
    snapshot.denials.some((policy) => !policy.dirty || policy.accounts.length)
  )
    throw new SlotRefused("policy");
}

/** Reconstructible per-boot recovery joins the endpoint's durable launch witness before changing selection. */
export class RuntimeSlotRecovery {
  private deps: Dependencies;
  private pending?: Promise<void>;
  private unavailable = false;
  constructor(deps: Dependencies) {
    this.deps = deps;
  }
  available() {
    return !this.unavailable;
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
    console.info("POOL_SELECTED_RECOVERY", {
      phase: "ready",
      at: Date.now(),
      slot: identity.slotId,
    });
  }
  private async runWithin(signal: AbortSignal) {
    const { storage, driver, provider, code, key } = this.deps;
    const completion = await storage.transact(async (_, transaction) =>
      transaction.get(completionKey),
    );
    if (completion != null) {
      this.unavailable = true;
      const value = Schema.decodeUnknownSync(Completion)(completion);
      await this.finish(value.identity, value.fingerprint, signal);
      return;
    }
    const snapshot = await storage.inspect();
    const selection = snapshot.selection;
    if (!selection) return;
    const previous = selection.active.identity;
    if (
      !previous ||
      selection.active.fenced ||
      selection.active.retirement ||
      selection.candidate ||
      selection.draining
    )
      throw new SlotRefused("selection");
    try {
      await driver.warm(previous, AbortSignal.any([signal, AbortSignal.timeout(2_000)]));
      this.unavailable = false;
      return;
    } catch {
      this.unavailable = true;
    }
    console.info("POOL_SELECTED_RECOVERY", {
      phase: "detected",
      at: Date.now(),
      slot: previous.slotId,
    });
    clean(snapshot);
    const retained = Schema.decodeUnknownSync(Retained)(await driver.recoveryWitness(previous));
    console.info("POOL_SELECTED_RECOVERY", {
      phase: "witness",
      at: Date.now(),
      slot: previous.slotId,
    });
    const original = retained.authorization;
    const operationId = `restart-${(await providerDigest(previous)).slice(0, 48)}`;
    const joining =
      original.kind === "restart" &&
      original.operationId === operationId &&
      sameIdentity(original.previous, previous);
    if (
      (!joining && (!sameIdentity(retained.identity, previous) || retained.running)) ||
      !sameTarget(original.target, previous)
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
      const observation = await provider.observe(
        application,
        attested ? previous.instanceId : undefined,
        signal,
      );
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
    await storage.transact(async (current) => {
      if (
        current.selection?.epoch !== selection.epoch ||
        !sameIdentity(current.selection.active.identity, previous) ||
        current.digest !== snapshot.digest
      )
        throw new SlotRefused("selection");
      clean(current);
    });
    if (!retained.running) await driver.admit(previous, await envelope(false));
    signal.throwIfAborted();
    console.info("POOL_SELECTED_RECOVERY", {
      phase: "starting",
      at: Date.now(),
      slot: previous.slotId,
    });
    const health = await driver.start(previous, signal);
    if (health.identity.bootId === previous.bootId) throw new SlotRefused("identity");
    const ready = await storage.inspect();
    clean(ready);
    if (ready.digest !== snapshot.digest) throw new SlotRefused("policy");
    // Expired positives stay absent on a fresh boot. Home renews them before recovery reports ready.
    await Promise.all(
      [
        ...ready.policies.filter((policy) => policy.expiresAt > Date.now()),
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
      clean(current);
      signal.throwIfAborted();
      await this.deps.beforeCommit?.(previous, health.identity, transaction);
      await transaction.put(slotSelectionKey, {
        ...selection,
        epoch: selection.epoch + 1,
        active: { ...selection.active, identity: health.identity },
      });
      await transaction.put(completionKey, {
        identity: health.identity,
        fingerprint: original.configurationFingerprint,
      });
    });
    await this.finish(health.identity, original.configurationFingerprint, signal);
  }
}
