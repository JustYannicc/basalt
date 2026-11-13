import { Schema } from "effect";
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
import type { RuntimeState } from "./runtime-state.ts";

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

/** Private configuration and launch provenance share the allocated per-slot witness record. */
export class RuntimeWitnessStore {
  private storage: RuntimeState["storage"];
  private secret: string;
  constructor(storage: RuntimeState["storage"], secret: string) {
    this.storage = storage;
    this.secret = secret;
  }
  retainAlarmTarget(target: SlotTarget) {
    return this.storage.put("runtime-alarm-v1:target", target);
  }
  async alarmTarget() {
    const value = await this.storage.get("runtime-alarm-v1:target");
    return value === undefined ? undefined : Schema.decodeUnknownSync(SlotTarget)(value);
  }
  async retained(slot: string) {
    const value = await this.storage.get(launchWitnessKey(slot));
    return value === undefined ? undefined : Schema.decodeUnknownSync(WitnessRecord)(value);
  }
  async read(target: SlotTarget) {
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
    const sealed = await sealConfiguration(configuration, this.secret, JSON.stringify(target));
    await this.put(target, { authorization, sealed, ...(identity ? { identity } : {}) });
  }
  put(target: SlotTarget, record: WitnessRecord) {
    return this.storage.put(launchWitnessKey(target.slotId), record);
  }
}
