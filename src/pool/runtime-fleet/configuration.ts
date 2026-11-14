import { Schema } from "effect";
import {
  ControllerCode,
  SlotIdentity,
  SlotRefused,
  sameControllerCode,
  sameIdentity,
  type PromotionIntent,
} from "../runtime-slots/contract.ts";
import { providerDigest } from "../runtime-provider/canonical.ts";
import type { RuntimeProviderReader } from "../runtime-provider/read.ts";
import type { SlotStorage, TransactionStorage } from "../runtime-slots/storage.ts";

const Identifier = Schema.NonEmptyString.check(Schema.isMaxLength(256));
const Digest = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/u));
export const FleetApplication = Schema.Struct({
  color: Schema.Literals(["blue", "green"]),
  accountId: Identifier,
  applicationId: Identifier,
  namespaceId: Identifier,
  applicationVersion: Identifier,
  imageDigest: Schema.String.check(Schema.isPattern(/^sha256:[a-f0-9]{64}$/u)),
  applicationConfigDigest: Digest,
  imageInput: Identifier,
});
export type FleetApplication = typeof FleetApplication.Type;
export const FleetConfiguration = Schema.Struct({
  format: Schema.Literal("pool-runtime-fleet-v1"),
  controllerCode: ControllerCode,
  controllerId: Identifier,
  legacy: SlotIdentity,
  revision: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER })),
  previousDigest: Schema.NullOr(Digest),
  active: Schema.Literals(["blue", "green"]),
  applications: Schema.Array(FleetApplication).check(Schema.isMinLength(2), Schema.isMaxLength(2)),
  maximum: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 4 })),
  targetActive: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 100_000 })),
  idleMilliseconds: Schema.Int.check(Schema.isBetween({ minimum: 1_000, maximum: 3_600_000 })),
});
export type FleetConfiguration = typeof FleetConfiguration.Type;
const Record = Schema.Struct({
  operationId: Identifier,
  digest: Digest,
  configuration: FleetConfiguration,
  enabled: Schema.Boolean,
});
export type FleetConfigurationRecord = typeof Record.Type;
const key = "runtime-fleet-v1:configuration";
const operationKey = (operationId: string) =>
  `runtime-fleet-v1:configuration-operation:${operationId}`;
export interface FleetBinding {
  color: FleetApplication["color"];
  applicationId: string;
  imageInput: string;
}
interface Dependencies {
  storage: TransactionStorage;
  controllerId: string;
  code: ControllerCode;
  bindings(): readonly FleetBinding[];
  legacy(storage?: SlotStorage): Promise<SlotIdentity | undefined>;
  occupied(storage?: SlotStorage): Promise<
    readonly {
      target: {
        applicationId: string;
        applicationVersion: string;
        imageDigest: string;
        imageInput: string;
      };
    }[]
  >;
  provider: RuntimeProviderReader;
  beforeCommit?(configuration: FleetConfiguration, transaction: SlotStorage): Promise<void>;
}

/** Only the signed deployment command may commit launch permission. Reads never refresh or enable it. */
export class RuntimeFleetConfiguration {
  private deps: Dependencies;
  constructor(deps: Dependencies) {
    this.deps = deps;
  }
  async inspect(operationId?: string, storage: SlotStorage = this.deps.storage) {
    const value = await storage.get(operationId ? operationKey(operationId) : key);
    return value === undefined ? undefined : Schema.decodeUnknownSync(Record)(value);
  }
  assertBindings(configuration: FleetConfiguration, currentCode = true) {
    if (
      configuration.controllerId !== this.deps.controllerId ||
      (currentCode && !sameControllerCode(configuration.controllerCode, this.deps.code)) ||
      configuration.legacy.controllerId !== this.deps.controllerId ||
      configuration.legacy.homePeerOrdinal !== undefined ||
      new Set(configuration.applications.map((value) => value.color)).size !== 2 ||
      new Set(configuration.applications.map((value) => value.applicationId)).size !== 2 ||
      new Set(configuration.applications.map((value) => value.namespaceId)).size !== 2 ||
      new Set(configuration.applications.map((value) => value.accountId)).size !== 1
    )
      throw new SlotRefused("identity");
    const bindings = this.deps.bindings();
    if (
      bindings.length !== 2 ||
      configuration.applications.some(
        (application) =>
          !bindings.some(
            (binding) =>
              binding.color === application.color &&
              binding.applicationId === application.applicationId &&
              binding.imageInput === application.imageInput,
          ),
      )
    )
      throw new SlotRefused("identity");
  }
  async promotePrimary(intent: PromotionIntent, transaction: SlotStorage) {
    const current = await this.inspect(undefined, transaction);
    if (!current) return;
    if (!sameIdentity(current.configuration.legacy, intent.previous))
      throw new SlotRefused("selection");
    const application = current.configuration.applications.find(
      (app) =>
        app.applicationId === intent.candidate.applicationId &&
        app.applicationVersion === intent.candidate.applicationVersion &&
        app.imageDigest === intent.candidate.imageDigest &&
        app.imageInput === intent.candidate.imageInput,
    );
    if (!application || intent.candidate.homePeerOrdinal !== undefined)
      throw new SlotRefused("identity");
    const configuration = Schema.decodeUnknownSync(FleetConfiguration)({
      ...current.configuration,
      legacy: intent.candidate,
      active: application.color,
      revision: current.configuration.revision + 1,
      previousDigest: current.digest,
    });
    this.assertBindings(configuration);
    const record = {
      ...current,
      operationId: `handoff-${intent.operationId}`,
      configuration,
      digest: await providerDigest(configuration),
    };
    await transaction.put(key, record);
    await transaction.put(operationKey(record.operationId), record);
  }
  private compare(previous: FleetConfigurationRecord | undefined, next: FleetConfiguration) {
    if (
      next.revision !== (previous?.configuration.revision ?? 0) + 1 ||
      next.previousDigest !== (previous?.digest ?? null)
    )
      throw new SlotRefused("selection");
  }
  private async assertOccupied(configuration: FleetConfiguration, storage?: SlotStorage) {
    const occupied = await this.deps.occupied(storage);
    if (occupied.length > configuration.maximum) throw new SlotRefused("uncertain");
    for (const row of occupied) {
      const app = configuration.applications.find(
        (value) => value.applicationId === row.target.applicationId,
      );
      if (
        !app ||
        app.applicationVersion !== row.target.applicationVersion ||
        app.imageDigest !== row.target.imageDigest ||
        app.imageInput !== row.target.imageInput
      )
        throw new SlotRefused("uncertain");
    }
  }
  async configure(operationId: string, input: FleetConfiguration) {
    Schema.decodeUnknownSync(Identifier)(operationId);
    const configuration = Schema.decodeUnknownSync(FleetConfiguration, {
      onExcessProperty: "error",
    })(input);
    this.assertBindings(configuration);
    const digest = await providerDigest(configuration);
    const retained = await this.inspect(operationId);
    if (retained) {
      if (retained.digest !== digest) throw new SlotRefused("identity");
      return retained;
    }
    this.compare(await this.inspect(), configuration);
    if (!sameIdentity(await this.deps.legacy(), configuration.legacy))
      throw new SlotRefused("identity");
    // A declaration cannot relabel an occupied resource as a newly deployed application version.
    await this.assertOccupied(configuration);
    for (const application of configuration.applications)
      await this.deps.provider.observe(application);
    const record = { operationId, digest, configuration, enabled: true };
    await this.deps.storage.transaction(async (transaction) => {
      const value = await transaction.get(key);
      this.compare(
        value === undefined ? undefined : Schema.decodeUnknownSync(Record)(value),
        configuration,
      );
      await this.assertOccupied(configuration, transaction);
      if (!sameIdentity(await this.deps.legacy(transaction), configuration.legacy))
        throw new SlotRefused("identity");
      await this.deps.beforeCommit?.(configuration, transaction);
      await transaction.put(key, record);
      await transaction.put(operationKey(operationId), record);
    });
    return record;
  }
  async disable(operationId: string, expectedDigest: string) {
    Schema.decodeUnknownSync(Identifier)(operationId);
    Schema.decodeUnknownSync(Digest)(expectedDigest);
    return this.deps.storage.transaction(async (transaction) => {
      const current = await this.inspect(undefined, transaction);
      if (!current || current.digest !== expectedDigest) throw new SlotRefused("selection");
      const retained = await this.inspect(operationId, transaction);
      if (retained) {
        if (retained.digest !== expectedDigest || retained.enabled)
          throw new SlotRefused("identity");
        return retained;
      }
      const record = { ...current, operationId, enabled: false };
      await transaction.put(key, record);
      await transaction.put(operationKey(operationId), record);
      return record;
    });
  }
}
