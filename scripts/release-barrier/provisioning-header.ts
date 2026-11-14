import { Schema } from "effect";
import { openRecovery } from "./recovery-envelope.ts";
import { decodeProvisioningRecord } from "./provisioning-journal.ts";
import { sameProvisioningValue } from "./provisioning-refusal.ts";

export const RuntimeProvisioningHeader = Schema.Struct({
  schemaVersion: Schema.Literal(2),
  kind: Schema.Literal("runtime-provisioning"),
  candidate: Schema.String,
  manifest: Schema.String,
  sealed: Schema.Unknown,
  complete: Schema.Boolean,
  previous: Schema.optionalKey(Schema.Unknown),
});
export function readRuntimeProvisioningHeader(value: unknown, key: string) {
  if (
    !Schema.is(
      Schema.Struct({
        schemaVersion: Schema.Literal(2),
        kind: Schema.Literal("runtime-provisioning"),
      }),
    )(value)
  )
    return undefined;
  const header = Schema.decodeUnknownSync(RuntimeProvisioningHeader, { onExcessProperty: "error" })(
    value,
  );
  const record = decodeProvisioningRecord(
    openRecovery(header.sealed, key, header.candidate, header.manifest, "worker-modules"),
  );
  sameProvisioningValue(
    "journal.authenticatedIdentity",
    { candidate: header.candidate, manifest: header.manifest, complete: header.complete },
    { candidate: record.candidate, manifest: record.manifest, complete: record.complete },
  );
  return { header, record };
}
