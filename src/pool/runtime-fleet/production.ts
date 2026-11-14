import {
  SlotRefused,
  SlotSelection,
  sameTarget,
  sameIdentity,
  type ControllerCode,
  type SlotTarget,
  type PromotionIntent,
} from "../runtime-slots/contract.ts";
import { Schema } from "effect";
import type { RuntimeHandoff, HandoffEnvironment } from "../runtime-slots/integration.ts";
import type { ControllerState } from "../runtime-slots/runtime-state.ts";
import type { RuntimeStub } from "../runtime-slots/transport.ts";
import type { NativeMembershipPolicy } from "../membership-contract.ts";
import type { NativeStreamLease } from "../native-streams.ts";
import { RuntimeProviderReader } from "../runtime-provider/read.ts";
import {
  RuntimeFleetConfiguration,
  type FleetBinding,
  type FleetConfiguration,
} from "./configuration.ts";
import { RuntimeFleetState } from "./state.ts";
import { RuntimeFleet } from "./controller.ts";
import { boundFleetCell } from "./bound-cell.ts";
import { RuntimeFleetPeers, type HomePeerEndpoint } from "./peers.ts";
import { RuntimeFleetReplacement } from "./replacement.ts";
import type { SlotIdentity } from "../runtime-slots/contract.ts";
import type { HomePeerSource } from "../runtime-slots/peer-access.ts";
import type { SlotStorage } from "../runtime-slots/storage.ts";
import { slotSelectionKey } from "../runtime-slots/storage.ts";
import { physicalPrimaryTargets } from "./physical.ts";
import { RuntimeImageUpdate, type ImageUpdateIntent } from "./image-update.ts";

export interface FleetNamespace extends FleetBinding {
  instanceId(name: string): string;
  endpoint(target: SlotTarget): RuntimeStub & HomePeerEndpoint;
}
interface Dependencies {
  ctx: ControllerState;
  env: HandoffEnvironment;
  code: ControllerCode;
  handoff: RuntimeHandoff;
  namespaces(): readonly FleetNamespace[];
  provider: RuntimeProviderReader;
  legacyPeers: HomePeerEndpoint;
  currentRequests(): number;
  wrap(response: Response, lease: NativeStreamLease): Response;
  schedule?(at: number): Promise<void>;
}

/** The public model path retains its existing admission authority and adds only execution routing. */
export class PoolRuntimeFleet {
  readonly state: RuntimeFleetState;
  readonly configuration: RuntimeFleetConfiguration;
  private deps: Dependencies;
  private runtime?: RuntimeFleet;
  private policy?: FleetConfiguration;
  private policyDigest?: string;
  private enabled = false;
  private peers: RuntimeFleetPeers;
  private replacement: RuntimeFleetReplacement;
  private imageUpdate: RuntimeImageUpdate;
  constructor(deps: Dependencies) {
    this.deps = deps;
    this.state = new RuntimeFleetState(deps.ctx.storage, 4, Date.now, (target, transaction) =>
      this.permission(target, transaction),
    );
    this.configuration = new RuntimeFleetConfiguration({
      storage: deps.ctx.storage,
      controllerId: deps.ctx.id.toString(),
      code: deps.code,
      bindings: () => deps.namespaces(),
      legacy: async (storage) => {
        if (!storage) return deps.handoff.selected();
        const raw = await storage.get(slotSelectionKey);
        const selection =
          raw === undefined ? undefined : Schema.decodeUnknownSync(SlotSelection)(raw);
        return selection &&
          !selection.candidate &&
          !selection.draining &&
          !selection.active.fenced &&
          !selection.active.retirement
          ? selection.active.identity
          : undefined;
      },
      occupied: (storage) => this.state.inspect(storage),
      provider: deps.provider,
      beforeCommit: (configuration, transaction) =>
        this.imageUpdate.complete(configuration, transaction),
    });
    this.imageUpdate = new RuntimeImageUpdate({
      storage: deps.ctx.storage,
      configuration: this.configuration,
      state: this.state,
      provider: deps.provider,
    });
    this.replacement = new RuntimeFleetReplacement({
      storage: deps.ctx.storage,
      state: this.state,
      target: (occupied) => this.target(occupied),
      drain: async (identity) => {
        const fleet = await this.fleet();
        if (!fleet) throw new SlotRefused("selection");
        return fleet.drain(identity);
      },
    });
    this.peers = new RuntimeFleetPeers({
      controllerId: deps.ctx.id.toString(),
      legacy: () => deps.handoff.selected(),
      sources: async () => {
        const value = await deps.ctx.storage.get(slotSelectionKey);
        if (value === undefined) return [];
        const selection = Schema.decodeUnknownSync(SlotSelection)(value);
        return [selection.active, selection.draining]
          .filter((slot) => slot?.identity && !slot.retirement)
          .map((slot) => slot!.identity!);
      },
      rows: () => this.state.inspect(),
      endpoint: (target) =>
        target.applicationId === deps.env.POOL_CONTAINER_APPLICATION_ID &&
        target.instanceId === deps.ctx.id.toString()
          ? deps.legacyPeers
          : this.namespace(target).endpoint(target),
    });
  }
  private namespace(target: SlotTarget) {
    if (target.controllerId !== this.deps.ctx.id.toString()) throw new SlotRefused("identity");
    const value = this.deps
      .namespaces()
      .find((entry) => entry.applicationId === target.applicationId);
    if (!value) throw new SlotRefused("identity");
    return value;
  }
  private async permission(target: SlotTarget, transaction: SlotStorage, launch = false) {
    await this.imageUpdate.assertLaunch(target, transaction);
    const record = await this.configuration.inspect(undefined, transaction);
    if (!record?.enabled) throw new SlotRefused("selection");
    this.configuration.assertBindings(record.configuration);
    const app = record.configuration.applications.find(
      (entry) => entry.color === record.configuration.active,
    );
    const rows = await this.state.inspect(transaction);
    const headroom = await this.imageUpdate.headroom(transaction);
    if (
      headroom &&
      rows.length + (await physicalPrimaryTargets(transaction)).length >=
        record.configuration.maximum - (launch ? 0 : 1)
    )
      throw new SlotRefused("draining");
    const reserved = rows.find((row) => sameTarget(row.target, target));
    const selected = await transaction.get(slotSelectionKey);
    const candidate =
      selected === undefined
        ? undefined
        : Schema.decodeUnknownSync(SlotSelection)(selected).candidate;
    if (
      candidate?.target.applicationId === target.applicationId ||
      !app ||
      app.applicationId !== target.applicationId ||
      app.applicationVersion !== target.applicationVersion ||
      app.imageDigest !== target.imageDigest ||
      app.imageInput !== target.imageInput ||
      (launch
        ? !reserved ||
          !["warming", "uncertain"].includes(reserved.phase) ||
          rows.length > record.configuration.maximum
        : rows.length >= record.configuration.maximum)
    )
      throw new SlotRefused("identity");
  }
  private async target(occupied: readonly SlotTarget[]) {
    const record = await this.configuration.inspect();
    if (!record) throw new SlotRefused("selection");
    this.configuration.assertBindings(record.configuration);
    const app = record.configuration.applications.find(
      (entry) => entry.color === record.configuration.active,
    )!;
    const namespace = this.deps.namespaces().find((entry) => entry.color === app.color)!;
    const slotId = crypto.randomUUID();
    const ordinal = Array.from({ length: 128 }, (_, index) => index + 1).find(
      (value) => !occupied.some((entry) => entry.homePeerOrdinal === value),
    );
    if (!ordinal) throw new SlotRefused("selection");
    return {
      format: "pool-runtime-slot-v1" as const,
      controllerId: this.deps.ctx.id.toString(),
      slotId,
      instanceId: namespace.instanceId(`runtime-${slotId}`),
      applicationId: app.applicationId,
      applicationVersion: app.applicationVersion,
      imageDigest: app.imageDigest,
      imageInput: app.imageInput,
      homePeerOrdinal: ordinal,
    };
  }
  private cell(target: SlotTarget) {
    const app = this.policy?.applications.find(
      (entry) => entry.applicationId === target.applicationId,
    );
    if (
      !app ||
      app.applicationVersion !== target.applicationVersion ||
      app.imageDigest !== target.imageDigest ||
      app.imageInput !== target.imageInput
    )
      throw new SlotRefused("identity");
    return boundFleetCell({
      ...this.deps,
      target,
      authorizeStart: (transaction) => this.permission(target, transaction, true),
      application: app,
      remote: (value) => this.namespace(value).endpoint(value),
    });
  }
  private async fleet() {
    const record = await this.configuration.inspect();
    if (!record) return undefined;
    this.enabled = record.enabled;
    if (record.digest !== this.policyDigest) this.runtime?.refreshPolicy();
    this.policyDigest = record.digest;
    this.policy = record.configuration;
    const policy = () => this.policy!;
    return (this.runtime ??= new RuntimeFleet({
      state: this.state,
      target: (occupied) => this.target(occupied),
      cell: (target) => this.cell(target),
      legacyActive: async () =>
        (await this.state.primaryActive()) + (await this.deps.handoff.legacyActive()),
      currentRequests: () => this.deps.currentRequests(),
      get targetActive() {
        return policy().targetActive;
      },
      get maximum() {
        return policy().maximum;
      },
      get idleMilliseconds() {
        return policy().idleMilliseconds;
      },
      defer: (work) => this.deps.ctx.waitUntil(work),
      wrap: this.deps.wrap,
      now: Date.now,
      enabled: () => this.enabled,
      changed: () => this.deps.ctx.waitUntil(this.schedule()),
      keepReady: (identity) => this.replacement.keepReady(identity),
      balancePrimary: true,
      demandAt: (at) => {
        if (this.deps.schedule) this.deps.ctx.waitUntil(this.deps.schedule(at));
      },
    }));
  }
  async configure(operationId: string, input: FleetConfiguration) {
    const record = await this.configuration.configure(operationId, input);
    this.runtime?.refreshPolicy();
    this.policyDigest = record.digest;
    this.policy = record.configuration;
    this.enabled = record.enabled;
    await this.schedule();
    return record;
  }
  async disable(operationId: string, expectedDigest: string) {
    const record = await this.configuration.disable(operationId, expectedDigest);
    this.enabled = false;
    await this.replacement.cancel();
    await this.schedule();
    return record;
  }
  async inspect(operationId?: string) {
    return {
      permission: await this.configuration.inspect(operationId),
      replacement: operationId ? await this.replacement.inspect(operationId) : undefined,
      resources: await this.state.inspect(),
      bindings: this.deps
        .namespaces()
        .map(({ color, applicationId, imageInput }) => ({ color, applicationId, imageInput })),
    };
  }
  async primaryTarget(operationId: string, applicationId: string): Promise<SlotTarget> {
    const permission = await this.configuration.inspect();
    const application = permission?.configuration.applications.find(
      (app) => app.applicationId === applicationId,
    );
    const binding = this.deps.namespaces().find((value) => value.applicationId === applicationId);
    if (!application || !binding || application.color === permission?.configuration.active)
      throw new SlotRefused("selection");
    return {
      format: "pool-runtime-slot-v1",
      controllerId: this.deps.ctx.id.toString(),
      slotId: operationId,
      instanceId: binding.instanceId(`primary-${operationId}`),
      applicationId,
      applicationVersion: application.applicationVersion,
      imageDigest: application.imageDigest,
      imageInput: application.imageInput,
    };
  }
  async replace(operationId: string, identity: SlotIdentity) {
    const receipt = await this.replacement.plan(operationId, identity);
    await this.schedule();
    return receipt;
  }
  async stagePrimary(target: SlotTarget, transaction: SlotStorage) {
    await this.imageUpdate.assertLaunch(target, transaction);
    const record = await this.configuration.inspect(undefined, transaction);
    const rows = await this.state.inspect(transaction);
    const primaries = await physicalPrimaryTargets(transaction);
    if (
      target.homePeerOrdinal !== undefined ||
      rows.some((row) => row.target.applicationId === target.applicationId) ||
      rows.length + primaries.length >= (record?.configuration.maximum ?? 4)
    )
      throw new SlotRefused("selection");
    if (record) {
      const value = await transaction.get(slotSelectionKey);
      const selection = Schema.decodeUnknownSync(SlotSelection)(value);
      if (!sameIdentity(selection.active.identity, record.configuration.legacy))
        throw new SlotRefused("selection");
    }
    await this.imageUpdate.consumeHeadroom(target, transaction);
  }
  async promotePrimary(intent: PromotionIntent, transaction: SlotStorage) {
    if (await this.imageUpdate.inspect(undefined, transaction)) throw new SlotRefused("selection");
    await this.configuration.promotePrimary(intent, transaction);
    await this.state.promoteGeneration(intent.candidate, transaction);
  }
  async prepareImage(intent: ImageUpdateIntent) {
    const receipt = await this.imageUpdate.prepare(intent);
    await this.primaryHeadroom();
    await this.schedule();
    return receipt;
  }
  inspectImage(operationId: string) {
    return this.imageUpdate.inspect(operationId);
  }
  cancelImage(operationId: string) {
    return this.imageUpdate.cancel(operationId);
  }
  async assertPrimaryChange(action: string) {
    if (["stage", "promote", "drain", "discard", "startup-abort"].includes(action)) return;
    if ((await this.configuration.inspect())?.enabled || (await this.state.inspect()).length)
      throw new SlotRefused("selection");
  }
  async forward(
    request: Request,
    pool: string | undefined,
    legacy: () => Promise<Response>,
    beforeDispatch: () => void,
  ) {
    const fleet = await this.fleet();
    return fleet && this.enabled ? fleet.forward(request, pool, legacy, beforeDispatch) : legacy();
  }
  async install(policy: NativeMembershipPolicy) {
    await (await this.fleet())?.install(policy);
  }
  abortPool(pool: string) {
    this.runtime?.abortPool(pool);
  }
  private async schedule() {
    if (!this.deps.schedule) return;
    const permission = await this.configuration.inspect();
    if (!permission) return;
    const now = Date.now();
    const deadlines = (await this.state.inspect())
      .map((row) => {
        if (row.phase === "ready")
          return permission.enabled && row.active
            ? undefined
            : Math.max(
                now + 100,
                row.lastUsedAt +
                  (permission.enabled ? permission.configuration.idleMilliseconds : 0),
              );
        if (row.phase === "draining" && row.active && row.drainAcknowledged) return undefined;
        return now + 2_000;
      })
      .filter((at) => at !== undefined);
    if (deadlines.length) await this.deps.schedule(Math.min(...deadlines));
  }
  private async primaryHeadroom() {
    if (!(await this.imageUpdate.headroom())) return;
    const permission = await this.configuration.inspect();
    if (!permission) throw new SlotRefused("selection");
    const rows = await this.state.inspect();
    if (
      rows.length + (await physicalPrimaryTargets(this.deps.ctx.storage)).length <
        permission.configuration.maximum ||
      rows.some((row) => ["draining", "retiring", "quarantined"].includes(row.phase))
    )
      return;
    const candidate = rows
      .filter((row) => row.phase === "ready" && row.identity)
      .sort((left, right) => left.active - right.active || left.lastUsedAt - right.lastUsedAt)[0];
    if (candidate?.identity) await (await this.fleet())?.drain(candidate.identity);
  }
  async upkeep() {
    try {
      await this.primaryHeadroom();
      const fleet = await this.fleet();
      if (!this.enabled) await this.replacement.cancel();
      await fleet?.upkeep();
      if (this.enabled) await this.replacement.upkeep();
    } finally {
      await this.schedule();
    }
  }
  homePeer(source: HomePeerSource, ordinal: number) {
    return this.peers.open(source, ordinal);
  }
}
