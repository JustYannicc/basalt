import { Schema } from "effect";
import { RuntimeResourceName } from "./runtime-create-schema.ts";
import { BarrierRefusal } from "./manifest.ts";
import {
  decodeProvisioningInput,
  provisioningRefusal,
  sameProvisioningValue,
} from "./provisioning-refusal.ts";

const ProvisioningResource = Schema.Union([
  RuntimeResourceName,
  Schema.Literal("PoolProviderObservationToken"),
]);
type ProvisioningResource = typeof ProvisioningResource.Type;
const hash = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/u));
const operation = Schema.Struct({
  request: hash,
  outcome: Schema.Literals(["pending", "unknown", "acknowledged"]),
  result: Schema.optionalKey(Schema.Unknown),
});
export const ProvisioningRecord = Schema.Struct({
  schemaVersion: Schema.Literal(2),
  candidate: Schema.String.check(Schema.isPattern(/^[a-f0-9]{40}$/u)),
  manifest: hash,
  resource: ProvisioningResource,
  complete: Schema.Boolean,
  receipt: Schema.optionalKey(hash),
  operations: Schema.Record(Schema.String, operation),
});
export type ProvisioningRecord = typeof ProvisioningRecord.Type;
const parse = decodeProvisioningInput(ProvisioningRecord, "journal.packet");
export function decodeProvisioningRecord(value: unknown) {
  const record = parse(value);
  if (
    record.complete &&
    (!record.receipt ||
      Object.values(record.operations).some((value) => value.outcome !== "acknowledged"))
  )
    throw provisioningRefusal(
      "provisioning-completion-unverified",
      "journal.complete",
      "receipt-and-all-acknowledged",
      "incomplete",
    );
  return record;
}

export interface ProvisioningStore {
  /** The admitted release's exclusive writer lease covers read, intent, send and acknowledgement. */
  exclusive<A>(work: () => Promise<A>): Promise<A>;
  read(expected: { candidate: string; manifest: string }): Promise<unknown>;
  write(record: ProvisioningRecord): Promise<void>;
}

export function provisioningJournal(
  store: ProvisioningStore,
  candidate: string,
  manifest: string,
  resource: ProvisioningResource = "PoolRuntime",
) {
  const read = async () => {
    const value = await store.read({ candidate, manifest });
    const record =
      value === undefined
        ? decodeProvisioningRecord({
            schemaVersion: 2,
            candidate,
            manifest,
            resource,
            complete: false,
            operations: {},
          })
        : decodeProvisioningRecord(value);
    sameProvisioningValue("journal.resource", resource, record.resource);
    sameProvisioningValue("journal.candidate", candidate, record.candidate);
    sameProvisioningValue("journal.manifest", manifest, record.manifest);
    return record;
  };
  return {
    read,
    finish: (receipt: string) =>
      store.exclusive(async () => {
        const record = await read();
        if (Object.values(record.operations).some((value) => value.outcome !== "acknowledged"))
          throw provisioningRefusal(
            "provisioning-operation-unknown",
            "journal.complete",
            "all-acknowledged",
            "pending-or-unknown",
          );
        if (record.complete) sameProvisioningValue("journal.receipt", record.receipt, receipt);
        else await store.write(decodeProvisioningRecord({ ...record, complete: true, receipt }));
      }),
    once: <A>(
      name: string,
      request: string,
      perform: () => Promise<A>,
      parse: (value: unknown) => A,
    ) =>
      store.exclusive(async () => {
        const record = await read();
        const prior = record.operations[name];
        if (prior) {
          sameProvisioningValue(`journal.${name}.request`, request, prior.request);
          if (prior.outcome === "acknowledged") return parse(prior.result);
          throw provisioningRefusal(
            "provisioning-operation-unknown",
            `journal.${name}.outcome`,
            "acknowledged",
            prior.outcome,
          );
        }
        if (record.complete)
          throw provisioningRefusal(
            "provisioning-journal-already-complete",
            `journal.${name}`,
            "existing-acknowledged-operation",
            "new-operation",
          );
        const pending = decodeProvisioningRecord({
          ...record,
          operations: { ...record.operations, [name]: { request, outcome: "pending" } },
        });
        await store.write(pending);
        let result: A;
        try {
          result = parse(await perform());
        } catch (error) {
          // A lost response cannot distinguish no write from a successful provider write.
          await store.write(
            decodeProvisioningRecord({
              ...pending,
              operations: { ...pending.operations, [name]: { request, outcome: "unknown" } },
            }),
          );
          if (error instanceof BarrierRefusal) throw error;
          throw provisioningRefusal(
            "provisioning-operation-unknown",
            `journal.${name}.outcome`,
            "acknowledged",
            "unknown",
          );
        }
        await store.write(
          decodeProvisioningRecord({
            ...pending,
            operations: {
              ...pending.operations,
              [name]: { request, outcome: "acknowledged", result },
            },
          }),
        );
        return result;
      }),
  };
}
export type ProvisioningJournal = ReturnType<typeof provisioningJournal>;
