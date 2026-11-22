import { Schema } from "effect";
import { startupStopKey } from "./startup-abort-contract.ts";
import { SlotIdentity, SlotRefused, SlotTarget, sameTarget } from "./contract.ts";
import {
  LaunchAuthorization,
  StartupWitness,
  VerifiedRuntimeAttestation,
  UnattestedActive,
  launchWitnessKey,
} from "./admission-proof.ts";
import {
  configurationDigest,
  openConfiguration,
  sealConfiguration,
  type RuntimeConfiguration,
} from "./configuration.ts";
import type { OwnedRuntimeStorage, RuntimeState } from "./runtime-state.ts";

const Authorization = Schema.Union([LaunchAuthorization, UnattestedActive]);
const WitnessRecord = Schema.Struct({
  authorization: Authorization,
  sealed: Schema.Struct({ iv: Schema.String, ciphertext: Schema.String }),
  identity: Schema.optional(SlotIdentity),
  witness: Schema.optional(StartupWitness),
  attestation: Schema.optional(VerifiedRuntimeAttestation),
  retired: Schema.optional(Schema.Boolean),
  failed: Schema.optional(Schema.Boolean),
});
export type WitnessRecord = typeof WitnessRecord.Type;

/** A fleet start its controller abandoned: no admission or start reaches its slot again. */
const abandonedStartKey = (slot: string) => `runtime-slots-v1:start-abandoned:${slot}`;
const alarmTargetKey = "runtime-alarm-v1:target";

/** Private configuration and launch provenance share the allocated per-slot witness record. */
export class RuntimeWitnessStore {
  private storage: RuntimeState["storage"];
  private secret: string;
  private owned?: OwnedRuntimeStorage;
  /** `owned` is given only where this store's storage is a runtime Durable Object's own. */
  constructor(storage: RuntimeState["storage"], secret: string, owned?: OwnedRuntimeStorage) {
    this.storage = storage;
    this.secret = secret;
    this.owned = owned;
  }
  /**
   * A slot's last write: retired, abandoned or its start aborted. A runtime object holds exactly one
   * slot, so the refresh alarm and target its start left are dropped in the same turn and commit
   * with it. The provider lists a retired cell whose object an alarm wakes as running, with a place.
   */
  async ended(write: () => Promise<unknown>) {
    await Promise.all([
      write(),
      ...(this.owned ? [this.owned.delete(alarmTargetKey), this.owned.deleteAlarm()] : []),
    ]);
  }
  retire(target: SlotTarget, record: WitnessRecord & { retired: true }) {
    return this.ended(() => this.put(target, record));
  }
  abandon(target: SlotTarget) {
    return this.ended(() => this.storage.put(abandonedStartKey(target.slotId), { target }));
  }
  async abandoned(slot: string) {
    return (await this.storage.get(abandonedStartKey(slot))) !== undefined;
  }
  retainAlarmTarget(target: SlotTarget) {
    return this.storage.put(alarmTargetKey, target);
  }
  async alarmTarget() {
    const value = await this.storage.get(alarmTargetKey);
    return value === undefined ? undefined : Schema.decodeUnknownSync(SlotTarget)(value);
  }
  async retained(slot: string) {
    const value = await this.storage.get(launchWitnessKey(slot));
    return value === undefined ? undefined : Schema.decodeUnknownSync(WitnessRecord)(value);
  }
  async read(target: SlotTarget) {
    if (await this.storage.get(startupStopKey(target))) throw new SlotRefused("selection");
    if (await this.abandoned(target.slotId)) throw new SlotRefused("selection");
    const record = await this.retained(target.slotId);
    if (!record || record.retired || !sameTarget(record.authorization.target, target))
      throw new SlotRefused("identity");
    const configuration = await openConfiguration(
      record.sealed,
      this.secret,
      JSON.stringify(record.authorization.target),
    );
    if (
      configuration.imageInput !== target.imageInput ||
      (await configurationDigest(configuration)) !== record.authorization.configurationFingerprint
    )
      throw new SlotRefused("identity");
    return { record, configuration };
  }
  async create(
    authorization: typeof Authorization.Type,
    configuration: RuntimeConfiguration,
    identity?: SlotIdentity,
  ) {
    const target = Schema.decodeUnknownSync(SlotTarget)(authorization.target);
    if (await this.storage.get(startupStopKey(target))) throw new SlotRefused("selection");
    if (await this.abandoned(target.slotId)) throw new SlotRefused("selection");
    const sealed = await sealConfiguration(configuration, this.secret, JSON.stringify(target));
    await this.put(target, { authorization, sealed, ...(identity ? { identity } : {}) });
  }
  put(target: SlotTarget, record: WitnessRecord) {
    return this.storage.put(launchWitnessKey(target.slotId), record);
  }
}
