import { Schema } from "effect";
import { SlotRefused, SlotSelection, type SlotTarget } from "../runtime-slots/contract.ts";
import {
  slotSelectionKey,
  type SlotStorage,
  type TransactionStorage,
} from "../runtime-slots/storage.ts";
import {
  FleetApplication,
  type FleetConfiguration,
  type RuntimeFleetConfiguration,
} from "./configuration.ts";
import type { RuntimeFleetState } from "./state.ts";
import type { RuntimeProviderReader } from "../runtime-provider/read.ts";
import { providerDigest } from "../runtime-provider/canonical.ts";

const Identifier = Schema.NonEmptyString.check(Schema.isMaxLength(128));
export const ImageUpdateIntent = Schema.Struct({
  operationId: Identifier,
  configurationDigest: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/u)),
  baseline: FleetApplication,
  imageDigest: FleetApplication.fields.imageDigest,
  imageInput: FleetApplication.fields.imageInput,
});
export type ImageUpdateIntent = typeof ImageUpdateIntent.Type;
const Record = Schema.Struct({
  intent: ImageUpdateIntent,
  phase: Schema.Literals(["checking", "prepared", "completed", "cancelled"]),
});
const key = "runtime-image-update-v1:pending";
const headroomKey = "runtime-image-update-v1:primary-headroom";
const receiptKey = (operationId: string) => `runtime-image-update-v1:receipt:${operationId}`;
interface Dependencies {
  storage: TransactionStorage;
  configuration: RuntimeFleetConfiguration;
  state: RuntimeFleetState;
  provider: RuntimeProviderReader;
}

/** The freeze has no timer: an uncertain provider write must never reopen launch permission. */
export class RuntimeImageUpdate {
  private deps: Dependencies;
  constructor(deps: Dependencies) {
    this.deps = deps;
  }
  async inspect(operationId?: string, storage: SlotStorage = this.deps.storage) {
    const value = await storage.get(operationId ? receiptKey(operationId) : key);
    return value === undefined || value === null
      ? undefined
      : Schema.decodeUnknownSync(Record)(value);
  }
  async assertLaunch(target: SlotTarget, transaction: SlotStorage) {
    const pending = await this.inspect(undefined, transaction);
    if (pending?.intent.baseline.applicationId === target.applicationId)
      throw new SlotRefused("selection");
  }
  async headroom(storage: SlotStorage = this.deps.storage) {
    const value = await storage.get(headroomKey);
    return value === undefined || value === null
      ? undefined
      : Schema.decodeUnknownSync(ImageUpdateIntent)(value);
  }
  async consumeHeadroom(target: SlotTarget, transaction: SlotStorage) {
    const intent = await this.headroom(transaction);
    if (!intent) return;
    if (
      target.applicationId !== intent.baseline.applicationId ||
      target.imageDigest !== intent.imageDigest ||
      target.imageInput !== intent.imageInput
    )
      throw new SlotRefused("identity");
    await transaction.put(headroomKey, null);
  }
  private async unoccupied(intent: ImageUpdateIntent, storage: SlotStorage) {
    const applicationId = intent.baseline.applicationId;
    const configuration = await this.deps.configuration.inspect(undefined, storage);
    if (!configuration || configuration.digest !== intent.configurationDigest)
      throw new SlotRefused("selection");
    const active = configuration.configuration.applications.find(
      (app) => app.color === configuration.configuration.active,
    );
    if (
      active?.applicationId === applicationId ||
      (await providerDigest(
        configuration.configuration.applications.find((app) => app.applicationId === applicationId),
      )) !== (await providerDigest(intent.baseline))
    )
      throw new SlotRefused("identity");
    const value = await storage.get(slotSelectionKey);
    const selection =
      value === undefined ? undefined : Schema.decodeUnknownSync(SlotSelection)(value);
    if (
      [selection?.active, selection?.candidate, selection?.draining].some(
        (slot) => slot?.target.applicationId === applicationId,
      ) ||
      (await this.deps.state.inspect(storage)).some(
        (row) => row.target.applicationId === applicationId,
      )
    )
      throw new SlotRefused("draining");
  }
  private async write(record: typeof Record.Type, storage: SlotStorage) {
    await storage.put(receiptKey(record.intent.operationId), record);
    await storage.put(key, ["checking", "prepared"].includes(record.phase) ? record : null);
    return record;
  }
  async prepare(input: ImageUpdateIntent) {
    const intent = Schema.decodeUnknownSync(ImageUpdateIntent)(input);
    const retained = await this.deps.storage.transaction(async (transaction) => {
      const receipt = await this.inspect(intent.operationId, transaction);
      if (receipt) {
        if ((await providerDigest(receipt.intent)) !== (await providerDigest(intent)))
          throw new SlotRefused("identity");
        return receipt;
      }
      if (await this.inspect(undefined, transaction)) throw new SlotRefused("selection");
      if (await this.headroom(transaction)) throw new SlotRefused("selection");
      await this.unoccupied(intent, transaction);
      await transaction.put(headroomKey, intent);
      return this.write({ intent, phase: "checking" }, transaction);
    });
    if (["completed", "cancelled"].includes(retained.phase)) return retained;
    if (!(await this.deps.provider.empty(intent.baseline))) throw new SlotRefused("uncertain");
    return this.deps.storage.transaction(async (transaction) => {
      await this.unoccupied(intent, transaction);
      const pending = await this.inspect(undefined, transaction);
      if (pending?.intent.operationId !== intent.operationId) throw new SlotRefused("selection");
      return this.write({ intent, phase: "prepared" }, transaction);
    });
  }
  async complete(configuration: FleetConfiguration, transaction: SlotStorage) {
    const pending = await this.inspect(undefined, transaction);
    if (!pending) return;
    const intent = pending.intent;
    const next = configuration.applications.find(
      (app) => app.applicationId === intent.baseline.applicationId,
    );
    if (
      pending.phase !== "prepared" ||
      !next ||
      next.imageDigest !== intent.imageDigest ||
      next.imageInput !== intent.imageInput ||
      next.accountId !== intent.baseline.accountId ||
      next.namespaceId !== intent.baseline.namespaceId ||
      next.color !== intent.baseline.color ||
      (next.applicationVersion === intent.baseline.applicationVersion &&
        (await providerDigest({ ...next, imageInput: intent.baseline.imageInput })) !==
          (await providerDigest(intent.baseline))) ||
      configuration.active === next.color
    )
      throw new SlotRefused("selection");
    await this.write({ intent, phase: "completed" }, transaction);
  }
  async cancel(operationId: string) {
    const pending = await this.inspect(operationId);
    if (!pending) throw new SlotRefused("selection");
    if (pending.phase === "cancelled") return pending;
    if (pending.phase === "completed" || !(await this.deps.provider.empty(pending.intent.baseline)))
      throw new SlotRefused("uncertain");
    return this.deps.storage.transaction(async (transaction) => {
      await this.unoccupied(pending.intent, transaction);
      const current = await this.inspect(undefined, transaction);
      if (current?.intent.operationId !== operationId) throw new SlotRefused("selection");
      await transaction.put(headroomKey, null);
      return this.write({ intent: pending.intent, phase: "cancelled" }, transaction);
    });
  }
}
