import { Schema } from "effect";
import { StartupWitness } from "./admission-proof.ts";
import { SlotIdentity, SlotRefused, sameIdentity, sameTarget } from "./contract.ts";
import { RuntimeWitnessStore } from "./witness-store.ts";
import type { ControllerState } from "./runtime-state.ts";
import { LaunchRecord } from "../launch-contract.ts";
import { launchStorageKey, launchTokenHash } from "../launch-ledger.ts";

export const HomePeerSource = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("runtime"), witness: StartupWitness }),
  Schema.Struct({ kind: Schema.Literal("legacy"), identity: SlotIdentity }),
]);
export type HomePeerSource = typeof HomePeerSource.Type;
export const homePeerSourceKey = "runtime-home-peer-v1:source";
export const peerTarget = (source: HomePeerSource) =>
  source.kind === "runtime" ? source.witness.target : source.identity;

function sameWitness(left: StartupWitness, right: StartupWitness) {
  return (
    sameTarget(left.target, right.target) &&
    left.operationId === right.operationId &&
    left.manifestDigest === right.manifestDigest &&
    left.configurationFingerprint === right.configurationFingerprint &&
    left.launch.operationId === right.launch.operationId &&
    left.launch.generation === right.launch.generation &&
    left.launch.tokenHash === right.launch.tokenHash
  );
}

/** Peer discovery may precede model readiness, but never the retained actual-start challenge. */
export class HomePeerAccess {
  private ctx: ControllerState;
  private store: RuntimeWitnessStore;
  private health: (identity: SlotIdentity) => Promise<unknown>;
  constructor(ctx: ControllerState, key: string, health: HomePeerAccess["health"]) {
    this.ctx = ctx;
    this.store = new RuntimeWitnessStore(ctx.storage, key);
    this.health = health;
  }
  async retain(source: HomePeerSource) {
    const parsed = Schema.decodeUnknownSync(HomePeerSource)(source);
    // Startup retains this before dispatch. It must not require a running process here.
    await this.record(parsed);
    await this.ctx.storage.put(homePeerSourceKey, parsed);
    return parsed;
  }
  async retained() {
    const value = await this.ctx.storage.get(homePeerSourceKey);
    if (value === undefined) return undefined;
    const source = Schema.decodeUnknownSync(HomePeerSource)(value);
    await this.record(source);
    return source;
  }
  async current() {
    const source = await this.retained();
    if (source) await this.assert(source);
    return source;
  }
  private async record(source: HomePeerSource) {
    const target = peerTarget(source);
    if (target.instanceId !== this.ctx.id.toString()) throw new SlotRefused("identity");
    const { record } = await this.store.read(target);
    if (source.kind === "legacy") {
      if (target.homePeerOrdinal !== undefined || !sameIdentity(record.identity, source.identity))
        throw new SlotRefused("identity");
      return;
    }
    if (
      target.homePeerOrdinal === undefined ||
      !record.witness ||
      !sameWitness(source.witness, record.witness)
    )
      throw new SlotRefused("identity");
    const launch = Schema.decodeUnknownSync(LaunchRecord)(
      await this.ctx.storage.get(launchStorageKey),
    );
    if (
      launch.generation !== source.witness.launch.generation ||
      launch.operationId !== source.witness.launch.operationId ||
      (await launchTokenHash(launch.token)) !== source.witness.launch.tokenHash ||
      launch.target.controllerId !== target.controllerId ||
      launch.target.instanceId !== target.instanceId ||
      launch.target.applicationId !== target.applicationId ||
      launch.target.versionId !== target.applicationVersion ||
      launch.target.imageHash !== target.imageInput ||
      launch.target.imageDigest !== target.imageDigest ||
      launch.target.releaseEpoch !== source.witness.manifestDigest
    )
      throw new SlotRefused("identity");
    return record.identity;
  }
  async assert(value: HomePeerSource) {
    const source = Schema.decodeUnknownSync(HomePeerSource)(value);
    const identity = await this.record(source);
    if (!this.ctx.container?.running) throw new SlotRefused("uncertain");
    if (source.kind === "legacy") await this.health(source.identity);
    else if (identity) await this.health(identity);
  }
}
