import {
  SlotRefused,
  SlotSelection,
  type ControllerCode,
  type SlotTarget,
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
  private async permission(target: SlotTarget, transaction: SlotStorage) {
    const record = await this.configuration.inspect(undefined, transaction);
    if (!record?.enabled) throw new SlotRefused("selection");
    this.configuration.assertBindings(record.configuration);
    const app = record.configuration.applications.find(
      (entry) => entry.color === record.configuration.active,
    );
    if (
      !app ||
      app.applicationId !== target.applicationId ||
      app.applicationVersion !== target.applicationVersion ||
      app.imageDigest !== target.imageDigest ||
      app.imageInput !== target.imageInput ||
      (await this.state.inspect(transaction)).length >= record.configuration.maximum
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
    };
  }
  async replace(operationId: string, identity: SlotIdentity) {
    const receipt = await this.replacement.plan(operationId, identity);
    await this.schedule();
    return receipt;
  }
  async assertPrimaryChange() {
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
  async upkeep() {
    try {
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
