import type { PersistedState } from "alchemy/State/State";
import { encodedRecordHash, recordedContainer } from "./forward-model.ts";
import { BarrierRefusal } from "./manifest.ts";
import { reviveStateRecursive } from "alchemy/State/StateEncoding";
import { Schema } from "effect";

const resource = Schema.declare<PersistedState>((value): value is PersistedState => {
  if (!value || typeof value !== "object") return false;
  const row = Object.fromEntries(Object.entries(value));
  return (
    row.resourceType === "Cloudflare.Container" &&
    row.fqn === "PoolContainer" &&
    typeof row.logicalId === "string" &&
    typeof row.instanceId === "string" &&
    typeof row.providerVersion === "number" &&
    Array.isArray(row.bindings) &&
    Array.isArray(row.downstream) &&
    (row.status === "created" || row.status === "updated" || row.status === "updating")
  );
});

/** Undo restores only the exact backed-up record and only while the adopted hash is still current. */
export async function undoForwardRecord(
  backup: unknown,
  io: {
    read(): Promise<PersistedState | undefined>;
    write(value: PersistedState): Promise<void>;
  },
) {
  const value = Schema.decodeUnknownSync(
    Schema.Struct({
      schemaVersion: Schema.Literal(1),
      before: Schema.Unknown,
      after: Schema.Unknown,
      receipt: Schema.Struct({ before: Schema.String, after: Schema.String }),
    }),
  )(backup);
  const before = Schema.decodeUnknownSync(resource)(reviveStateRecursive(value.before));
  recordedContainer(before);
  if (
    encodedRecordHash(before) !== value.receipt.before ||
    encodedRecordHash(value.after) !== value.receipt.after
  )
    throw new BarrierRefusal("forward-undo-backup-mismatch");
  const current = await io.read();
  if (encodedRecordHash(current) === value.receipt.before)
    return { disposition: "already-restored", hash: value.receipt.before };
  if (encodedRecordHash(current) !== value.receipt.after)
    throw new BarrierRefusal("forward-undo-current-drift");
  await io.write(before);
  if (encodedRecordHash(await io.read()) !== value.receipt.before)
    throw new BarrierRefusal("forward-undo-unconfirmed");
  return { disposition: "restored", hash: value.receipt.before };
}
