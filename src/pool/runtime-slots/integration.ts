import { RuntimeSlotRecovery, primaryLastEnd } from "./recovery.ts";
import { lastRecovery } from "./recovery-record.ts";
import { UnservingClock } from "./unserving-clock.ts";
import type { RuntimeProviderReader } from "../runtime-provider/read.ts";
import { Schema } from "effect";
import { observeUnattestedAdoption } from "./adoption-observation.ts";
import type { UnattestedActive } from "./admission-proof.ts";
import { RuntimeSlotAuthority } from "./authority.ts";
import { configurationDigest, runtimeConfiguration } from "./configuration.ts";
import { RuntimeSlots } from "./controller.ts";
import { RuntimeStaging } from "./staging.ts";
import { RuntimeStartupAbort } from "./startup-abort.ts";
import type { StartupStopRecord } from "./startup-abort-contract.ts";
import { slotSelectionKey, RuntimeSlotStorage } from "./storage.ts";
import { RuntimeSlotRouter } from "./router.ts";
import { SlotStreams } from "./streams.ts";
import { slotClock } from "./proof.ts";
import { BoundSlotDriver, runtimeRequest, type RuntimeStub } from "./transport.ts";
import { RuntimeEndpoint, type EndpointEnvironment, type EndpointOptions } from "./endpoint.ts";
import {
  SlotRefused,
  awaitsProof,
  type ControllerCode,
  type SlotIdentity,
  type SlotTarget,
  type PromotionIntent,
} from "./contract.ts";
import type { PoolStatus } from "../lifecycle.ts";
import type { NativeStreamLease } from "../native-streams.ts";
import type { ControllerState } from "./runtime-state.ts";
import { LegacyActivity } from "./legacy-activity.ts";
import type { SlotStorage } from "./storage.ts";
import type { PeerBootstrapInput } from "./peer-bootstrap.ts";
import type { RetirementProvider } from "./retirement.ts";
import type { HomeDatabasePoolObservation } from "../home-database-pool.ts";

export interface HandoffEnvironment extends EndpointEnvironment {
  POOL_DESIRED_IMAGE_INPUT?: string;
}
interface Options {
  endpoint?: EndpointOptions;
  remote?: (target: SlotTarget) => RuntimeStub;
  wrap(response: Response, lease: NativeStreamLease): Response;
  beforeStage?(target: SlotTarget, transaction: SlotStorage): Promise<void>;
  beforePromote?(intent: PromotionIntent, transaction: SlotStorage): Promise<void>;
  retirementProvider?: RetirementProvider;
  startupAbsence?(record: StartupStopRecord): Promise<void>;
  selectedChanged?(): Promise<void>;
  /** The last counters Home reported; active-health returns them without reading Home. */
  databasePool?(): HomeDatabasePoolObservation | null;
  recovery?: {
    provider: RuntimeProviderReader;
    beforeCommit?(
      previous: SlotIdentity,
      next: SlotIdentity,
      transaction: SlotStorage,
    ): Promise<void>;
    afterCommit?(identity: SlotIdentity, fingerprint: string): Promise<void>;
  };
}
/** No selection means the existing deployment. A broken admitted selection never falls back. */
export class RuntimeHandoff {
  readonly storage: RuntimeSlotStorage;
  private authorityCheck?: RuntimeSlotAuthority;
  private controller?: RuntimeSlots;
  private startup?: RuntimeStaging;
  private abortingStartup?: RuntimeStartupAbort;
  private controllerCode: ControllerCode;
  private driver: BoundSlotDriver;
  private routing?: RuntimeSlotRouter;
  private streams = new SlotStreams();
  private adopting?: Promise<void>;
  private recovery?: RuntimeSlotRecovery;
  private preparations = new Set<Promise<void>>();
  private ctx: ControllerState;
  private options: Options;
  private env: HandoffEnvironment;
  private legacyActivity: LegacyActivity;
  private legacyEndpoint: RuntimeEndpoint;
  constructor(
    ctx: ControllerState,
    env: HandoffEnvironment,
    code: ControllerCode,
    options: Options,
  ) {
    this.ctx = ctx;
    this.options = options;
    this.env = env;
    this.controllerCode = code;
    this.storage = new RuntimeSlotStorage(ctx.storage);
    this.legacyActivity = new LegacyActivity(ctx.storage);
    const local = new RuntimeEndpoint(ctx, env, "legacy", code, options.wrap, options.endpoint);
    this.legacyEndpoint = local;
    this.driver = new BoundSlotDriver((target): RuntimeStub => {
      if (target.controllerId !== ctx.id.toString()) throw new SlotRefused("identity");
      if (
        target.applicationId === env.POOL_CONTAINER_APPLICATION_ID &&
        target.instanceId === ctx.id.toString()
      )
        return { fetch: (request) => runtimeRequest(request, local) };
      if (!options.remote) throw new SlotRefused("selection");
      return options.remote(target);
    });
  }
  get slots() {
    return (this.controller ??= new RuntimeSlots({
      controllerId: this.ctx.id.toString(),
      controllerCode: this.controllerCode,
      storage: this.storage,
      driver: this.driver,
      streams: this.streams,
      beforeStage: this.options.beforeStage,
      beforePromote: this.options.beforePromote,
      retirementProvider: this.options.retirementProvider,
    }));
  }
  get startupAbort() {
    return (this.abortingStartup ??= new RuntimeStartupAbort(
      this.storage,
      this.ctx.storage,
      this.driver,
      this.options.startupAbsence,
    ));
  }
  get staging() {
    return (this.startup ??= new RuntimeStaging(
      this.slots,
      this.storage,
      this.ctx.storage,
      (work) => this.ctx.waitUntil(work),
    ));
  }
  private get router() {
    return (this.routing ??= new RuntimeSlotRouter({
      controllerId: this.ctx.id.toString(),
      driver: this.driver,
      storage: this.storage,
      streams: this.streams,
      clock: slotClock,
      defer: (work) => this.ctx.waitUntil(work),
      wrap: this.options.wrap,
      ...(this.options.databasePool ? { databasePool: this.options.databasePool } : {}),
    }));
  }
  async selected() {
    if ((await this.ctx.storage.get(slotSelectionKey)) === undefined) return undefined;
    const { selection } = await this.storage.inspect();
    if (!selection) return undefined;
    const active = selection.active;
    if (!active.identity || active.fenced || active.retirement) throw new SlotRefused("selection");
    const local =
      active.identity.instanceId === this.ctx.id.toString() &&
      active.identity.applicationId === this.env.POOL_CONTAINER_APPLICATION_ID;
    if (!local && !this.options.remote) throw new SlotRefused("selection");
    return active.identity;
  }
  available() {
    return this.recovery?.available() ?? true;
  }
  /** How long a call may still wait for the selected root's recovery; 0 when none is restoring it. */
  recoveryHoldMs() {
    return this.recovery?.holdMs() ?? 0;
  }
  /** The forced-restart clock, readable while the runtime refuses: "needs a person" shows here. */
  recoveryState() {
    return new UnservingClock(this.storage).inspect();
  }
  /** How the last primary a recovery restarted had ended. */
  primaryEnd() {
    return primaryLastEnd(this.ctx.storage);
  }
  /** The selected root's last recovery: detected, ready, its rounds and their refusals. */
  lastRecovery() {
    return lastRecovery(this.ctx.storage);
  }
  resetRecovery() {
    return new UnservingClock(this.storage).reset();
  }
  supervise() {
    if (!this.options.recovery) return Promise.resolve();
    this.recovery ??= new RuntimeSlotRecovery({
      ...this.options.recovery,
      storage: this.storage,
      driver: this.driver,
      code: this.controllerCode,
      key: this.env.POOL_DEPLOYMENT_KEY ?? "",
    });
    return this.recovery.recover();
  }
  legacyActive() {
    return this.legacyActivity.active();
  }
  async retireDrained() {
    const { selection } = await this.storage.inspect();
    const slot = selection?.draining;
    if (!slot?.identity) return;
    const operationId =
      slot.retirement?.operationId ?? `primary-drain-${selection!.epoch}-${slot.target.slotId}`;
    return this.slots.retireDrained(operationId);
  }
  crash(identity: SlotIdentity, envelope: string) {
    return this.driver.crash(identity, envelope);
  }
  inspectCrash(identity: SlotIdentity, nonce: string) {
    return this.driver.inspectCrash(identity, nonce);
  }
  peerHealth(identity: SlotIdentity) {
    return this.legacyEndpoint.health(identity, AbortSignal.timeout(2_000));
  }
  async status(signal = AbortSignal.timeout(2_000)) {
    const identity = await this.selected();
    if (!identity) return undefined;
    await this.assertProven();
    const health = await this.driver.health(identity, signal);
    return {
      boot_id: identity.bootId,
      started_at: "selected-runtime",
      policyLeaseUntil: health.policyLeaseUntil,
      ...(health.database ? { database: health.database } : {}),
    };
  }
  databasePool() {
    return this.options.databasePool?.() ?? null;
  }
  /** Nothing reports a slot an unfence handed back as serving until it is proven. */
  private async assertProven() {
    if (awaitsProof((await this.storage.inspect()).selection?.active))
      throw new SlotRefused("selection");
  }
  async activeHealth() {
    const identity = await this.selected();
    if (!identity) throw new SlotRefused("selection");
    await this.assertProven();
    const health = await this.driver.health(identity, AbortSignal.timeout(2_000));
    return {
      identity,
      leaseMs: Math.floor(health.policyLeaseUntil - performance.now()),
      ...(this.options.databasePool ? { homeDatabasePool: this.options.databasePool() } : {}),
      ...(health.database ? { database: health.database } : {}),
    };
  }
  private async choose<T>(
    legacy: (prepared: () => void) => Promise<T>,
    selected: (identity: SlotIdentity) => Promise<T>,
  ): Promise<T> {
    while (true) {
      if (this.adopting) await this.adopting;
      const identity = await this.selected();
      if (this.adopting) continue;
      if (identity) return selected(identity);
      let finish = () => {};
      const pending = new Promise<void>((resolve) => {
        finish = resolve;
      });
      this.preparations.add(pending);
      const prepared = () => {
        this.preparations.delete(pending);
        finish();
      };
      try {
        return await legacy(prepared);
      } finally {
        prepared();
      }
    }
  }
  private get authority() {
    return (this.authorityCheck ??= new RuntimeSlotAuthority(
      this.storage,
      this.controllerCode,
      this.ctx.id.toString(),
      this.env.POOL_DEPLOYMENT_KEY ?? "",
    ));
  }
  async adopt(envelope: string) {
    const proof = await this.authority.read(envelope);
    if (proof.kind !== "unattested-active") throw new SlotRefused("identity");
    if (this.adopting) throw new SlotRefused("uncertain");
    let finish = () => {};
    const barrier = new Promise<void>((resolve) => {
      finish = resolve;
    });
    this.adopting = barrier;
    try {
      await Promise.all(this.preparations);
      await this.authority.selection(proof);
      await this.driver.admit(proof.target, envelope);
      await this.slots.adopt(
        { ...proof.target, bootId: proof.bootId },
        proof.selection.policyDigest,
      );
      return await this.witness(proof.target, proof);
    } finally {
      await this.options.selectedChanged?.();
      this.adopting = undefined;
      finish();
    }
  }
  async stage(envelope: string) {
    const proof = await this.authority.read(envelope);
    if (proof.kind !== "start" || !proof.selection.active) throw new SlotRefused("identity");
    await this.authority.selection(proof);
    return this.slots.stage(
      proof.target,
      {
        epoch: proof.selection.expectedEpoch,
        active: proof.selection.active,
        digest: proof.selection.policyDigest,
      },
      () => this.driver.admit(proof.target, envelope),
    );
  }
  async beginStage(envelope: string) {
    const proof = await this.authority.read(envelope);
    if (proof.kind !== "start" || !proof.selection.active) throw new SlotRefused("identity");
    await this.authority.selection(proof);
    return this.staging.begin(proof, () => this.driver.admit(proof.target, envelope));
  }
  async startInitial(envelope: string) {
    const proof = await this.authority.read(envelope);
    if (proof.kind !== "initial-start" || !this.options.remote || this.ctx.container)
      throw new SlotRefused("identity");
    await this.authority.selection(proof);
    await this.driver.admit(proof.target, envelope);
    return this.slots.firstStart.start(proof.target, proof.selection.policyDigest);
  }
  async activateInitial(envelope: string) {
    const proof = await this.authority.read(envelope);
    if (proof.kind !== "initial-attested") throw new SlotRefused("identity");
    await this.authority.selection(proof);
    await this.driver.attest(proof.target, envelope);
    return this.slots.firstStart.activate(
      { ...proof.target, bootId: proof.bootId },
      proof.selection.policyDigest,
      () => this.authority.fresh(proof),
    );
  }
  async bootstrapPeer(input: PeerBootstrapInput, signal: AbortSignal) {
    const { selection } = await this.storage.inspect();
    if (
      !selection ||
      ![selection.active, selection.draining].some(
        (slot) =>
          slot?.identity?.bootId === input.identity.bootId &&
          slot.identity.instanceId === this.ctx.id.toString(),
      )
    )
      throw new SlotRefused("selection");
    return this.legacyEndpoint.bootstrapPeer(input, signal);
  }
  /**
   * A fence stopped the fleet alarm that runs recovery, so an unfence arms it again. Armed before
   * the unfence commits too, so an object reset between the two still runs recovery; a pass under
   * a fence that holds refuses and arms nothing further.
   */
  async unfence(identity: SlotIdentity) {
    await this.options.selectedChanged?.();
    const unfenced = await this.slots.unfence(identity);
    await this.options.selectedChanged?.();
    return unfenced;
  }
  async promote(intent: PromotionIntent, envelope: string) {
    const proof = await this.authority.promotion(intent, envelope);
    await this.driver.attest(proof.target, envelope);
    const receipt = await this.slots.promote(intent, () => this.authority.fresh(proof));
    await this.options.selectedChanged?.();
    return receipt;
  }
  /** A fleet first start's witness, read with this controller's code for its endpoint to adopt. */
  startWitness(target: SlotTarget) {
    return this.driver.witness(target, this.controllerCode);
  }
  async witness(target: SlotTarget, expected?: UnattestedActive) {
    const value = await this.driver.witness(target);
    const { kind } = Schema.decodeUnknownSync(Schema.Struct({ kind: Schema.String }))(value);
    if (kind !== "unattested-active") return value;
    return observeUnattestedAdoption(
      {
        controllerCode: this.controllerCode,
        driver: this.driver,
        storage: this.storage,
        clock: slotClock,
      },
      target,
      value,
      expected,
    );
  }
  warm(legacy: () => Promise<PoolStatus>) {
    return this.choose(
      () => legacy(),
      async (identity) => {
        await this.assertProven();
        const health = await this.driver.warm(identity, AbortSignal.timeout(2_000));
        return {
          boot_id: identity.bootId,
          started_at: "selected-runtime",
          policyLeaseUntil: health.policyLeaseUntil,
        };
      },
    );
  }
  async ready(legacy: () => Promise<void>) {
    await this.choose(
      () => legacy(),
      async () => {
        await this.status();
      },
    );
  }
  recover(legacy: () => Promise<PoolStatus>) {
    return this.choose(
      () => legacy(),
      async () => {
        throw new SlotRefused("selection");
      },
    );
  }
  deploymentReady(
    legacy: () => Promise<{ bootId: string; desiredRevisionMatch: true; readyAt: number }>,
  ) {
    return this.choose(
      () => legacy(),
      async (identity) => {
        await this.assertProven();
        const observed = Schema.decodeUnknownSync(Schema.Struct({ kind: Schema.String }))(
          await this.driver.witness(identity),
        );
        if (observed.kind === "unattested-active") throw new Error("Unattested active runtime");
        await this.driver.ready(
          identity,
          await configurationDigest(runtimeConfiguration(this.env)),
          this.env.POOL_DESIRED_IMAGE_INPUT ?? this.env.POOL_IMAGE_HASH,
        );
        return {
          desiredRevisionMatch: true as const,
          instanceId: identity.instanceId,
          bootId: identity.bootId,
          readyAt: Date.now(),
        };
      },
    );
  }
  async forward(
    request: Request,
    port: 8317 | 8327,
    pool: string | undefined,
    legacy: (request: Request, prepared: () => void) => Promise<Response>,
    beforeDispatch: () => void = () => {},
  ) {
    if (!this.options.remote && (await this.ctx.storage.get(slotSelectionKey)) === undefined) {
      return legacy(request, beforeDispatch);
    }
    // Pre-adoption requests remain unbound leases and block retirement until their bodies close.
    const pending = this.streams.acquire(pool ?? "", request.signal);
    try {
      return await this.choose(
        async (prepared) => {
          const done = await this.legacyActivity.acquire();
          const forwarded = new Request(request, { signal: pending.lease.signal });
          let dispatched = false;
          try {
            const response = await legacy(forwarded, () => {
              prepared();
              beforeDispatch();
              dispatched = true;
            });
            return this.options.wrap(response, {
              ...pending.lease,
              release: () => {
                this.ctx.waitUntil(done());
                return pending.lease.release();
              },
            });
          } catch (error) {
            if (!dispatched) void forwarded.body?.cancel().catch(() => {});
            await done();
            throw error;
          }
        },
        async () => {
          pending.lease.release();
          return this.router.forward(pool, request, port, async () => request, beforeDispatch);
        },
      );
    } catch (error) {
      pending.lease.release();
      throw error;
    }
  }
  forwardCandidate(
    request: Request,
    identity: SlotIdentity,
    pool: string,
    beforeDispatch: () => void,
  ) {
    return this.router.forward(pool, request, 8317, async () => request, beforeDispatch, identity);
  }
  abortPool(pool: string) {
    this.streams.abortPool(pool);
  }
  /** Probe traffic shares selection and transport but never repairs or starts a runtime. */
  async probeNative(
    policy: import("../membership-contract.ts").NativeMembershipPolicy,
    signal: AbortSignal,
  ) {
    const selected = await this.selected();
    if (!selected) throw new SlotRefused("selection");
    await this.assertProven();
    await this.driver.native(selected, policy, signal);
  }
  async probeFetch(request: Request, port: 8318 | 8327) {
    const selected = await this.selected();
    if (!selected) throw new SlotRefused("selection");
    await this.assertProven();
    return this.driver.probeFetch(selected, request, port);
  }
}
