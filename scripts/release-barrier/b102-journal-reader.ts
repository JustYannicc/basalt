import { Schema } from "effect";
import { readFileSync } from "node:fs";
import { digest } from "./manifest.ts";
import { openRecovery } from "./recovery-envelope.ts";
import {
  decodeProvisioningInput,
  provisioningRefusal,
  sameProvisioningValue,
} from "./provisioning-refusal.ts";

// Frozen decoder contract from 5f27c105862180cf2d6b34abdf870ded0aafd672; do not widen it with current resource kinds.
export const b102ReaderCommit = "5f27c105862180cf2d6b34abdf870ded0aafd672";
const hash = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/u));
const Record = Schema.Struct({
  schemaVersion: Schema.Literal(2),
  candidate: Schema.String.check(Schema.isPattern(/^[a-f0-9]{40}$/u)),
  manifest: hash,
  resource: Schema.Union([
    Schema.Literals(["PoolRuntime", "PoolRuntimeBlue", "PoolRuntimeGreen"]),
    Schema.Literal("PoolProviderObservationToken"),
  ]),
  complete: Schema.Boolean,
  receipt: Schema.optionalKey(hash),
  operations: Schema.Record(
    Schema.String,
    Schema.Struct({
      request: hash,
      outcome: Schema.Literals(["pending", "unknown", "acknowledged"]),
      result: Schema.optionalKey(Schema.Unknown),
    }),
  ),
});
const parse = decodeProvisioningInput(Record, "journal.packet");
export function decodeB102ProvisioningRecord(value: unknown) {
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
const Legacy = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  candidate: Schema.String,
  manifest: Schema.String,
  sealed: Schema.Unknown,
  complete: Schema.Boolean,
});
const Header = Schema.Struct({
  schemaVersion: Schema.Literal(2),
  kind: Schema.Literal("runtime-provisioning"),
  candidate: Schema.String,
  manifest: Schema.String,
  sealed: Schema.Unknown,
  complete: Schema.Boolean,
  previous: Schema.optionalKey(Schema.Unknown),
});
export function assertB102CompletedHead(value: unknown, key: string) {
  if (
    Schema.is(
      Schema.Struct({
        schemaVersion: Schema.Literal(2),
        kind: Schema.Literal("runtime-provisioning"),
      }),
    )(value)
  ) {
    const header = Schema.decodeUnknownSync(Header, { onExcessProperty: "error" })(value);
    const record = decodeB102ProvisioningRecord(
      openRecovery(header.sealed, key, header.candidate, header.manifest, "worker-modules"),
    );
    sameProvisioningValue(
      "restore.previous.authenticatedIdentity",
      { candidate: header.candidate, manifest: header.manifest, complete: header.complete },
      { candidate: record.candidate, manifest: record.manifest, complete: record.complete },
    );
    if (!record.complete) throw new Error("Previous provisioning head is incomplete");
  } else if (!Schema.decodeUnknownSync(Legacy)(value).complete) {
    throw new Error("Previous forward head is incomplete");
  }
}
export const b102ReaderDigest = () =>
  digest(readFileSync(new URL("./b102-journal-reader.ts", import.meta.url)));
