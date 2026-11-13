import { Schema } from "effect";
import { observeUnattestedAdoption } from "./adoption-observation.ts";
import type { UnattestedActive } from "./admission-proof.ts";
import { RuntimeSlotAuthority } from "./authority.ts";
import { configurationDigest, runtimeConfiguration } from "./configuration.ts";
import { RuntimeSlots } from "./controller.ts";
import { slotSelectionKey, RuntimeSlotStorage } from "./storage.ts";
import { RuntimeSlotRouter } from "./router.ts";
import { SlotStreams } from "./streams.ts";
import { slotClock } from "./proof.ts";
import { BoundSlotDriver, runtimeRequest, type RuntimeStub } from "./transport.ts";
import { RuntimeEndpoint, type EndpointEnvironment, type EndpointOptions } from "./endpoint.ts";
import {
  SlotRefused,
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
}
/** No selection means the existing deployment. A broken admitted selection never falls back. */
export class RuntimeHandoff {
  readonly storage: RuntimeSlotStorage;
  private authorityCheck?: RuntimeSlotAuthority;
  private controller?: RuntimeSlots;
  private controllerCode: ControllerCode;
  private driver: BoundSlotDriver;
  private routing?: RuntimeSlotRouter;
  private streams = new SlotStreams();
  private adopting?: Promise<void>;
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
  private get router() {
    return (this.routing ??= new RuntimeSlotRouter({
      controllerId: this.ctx.id.toString(),
      driver: this.driver,
      storage: this.storage,
      streams: this.streams,
      clock: slotClock,
      defer: (work) => this.ctx.waitUntil(work),
      wrap: this.options.wrap,
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
  peerHealth(identity: SlotIdentity) {
    return this.legacyEndpoint.health(identity, AbortSignal.timeout(2_000));
  }
  async status(signal = AbortSignal.timeout(2_000)) {
    const identity = await this.selected();
    if (!identity) return undefined;
    const health = await this.driver.health(identity, signal);
    return {
      boot_id: identity.bootId,
      started_at: "selected-runtime",
      policyLeaseUntil: health.policyLeaseUntil,
    };
  }
  async activeHealth() {
    const identity = await this.selected();
    if (!identity) throw new SlotRefused("selection");
    const health = await this.driver.health(identity, AbortSignal.timeout(2_000));
    return { identity, leaseMs: Math.floor(health.policyLeaseUntil - performance.now()) };
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
  async promote(intent: PromotionIntent, envelope: string) {
    const proof = await this.authority.promotion(intent, envelope);
    await this.driver.attest(proof.target, envelope);
    return this.slots.promote(intent, () => this.authority.fresh(proof));
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
      return legacy(request, () => {});
    }
    // Pre-adoption requests remain unbound leases and block retirement until their bodies close.
    const pending = this.streams.acquire(pool ?? "", request.signal);
    try {
      return await this.choose(
        async (prepared) => {
          const done = await this.legacyActivity.acquire();
          try {
            const response = await legacy(
              new Request(request, { signal: pending.lease.signal }),
              prepared,
            );
            return this.options.wrap(response, {
              ...pending.lease,
              release: () => {
                this.ctx.waitUntil(done());
                return pending.lease.release();
              },
            });
          } catch (error) {
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
    await this.driver.native(selected, policy, signal);
  }
  async probeFetch(request: Request, port: 8318 | 8327) {
    const selected = await this.selected();
    if (!selected) throw new SlotRefused("selection");
    return this.driver.probeFetch(selected, request, port);
  }
}
