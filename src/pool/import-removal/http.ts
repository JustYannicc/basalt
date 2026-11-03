import { Schema } from "effect";
import { openEnvelope } from "../token.ts";
import { importRemovalName, RemovalRefused } from "./contract.ts";
import type { ImportRemoval } from "./operation.ts";

const Signed = Schema.Struct({
  version: Schema.Literal(1),
  id: Schema.String,
  target: Schema.String,
  at: Schema.Number,
  expiresAt: Schema.Number,
  operation: Schema.Struct({
    action: Schema.String,
    selection: Schema.Literal(importRemovalName),
    request: Schema.Unknown,
    recipient: Schema.String,
    artifact: Schema.optional(Schema.Unknown),
    planSha256: Schema.optional(Schema.String),
    backupSha256: Schema.optional(Schema.String),
    go: Schema.optional(Schema.String),
  }),
});

async function boundedBody(request: Request) {
  const reader = request.body?.getReader();
  if (!reader) throw new RemovalRefused(400);
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.byteLength;
      if (size > 2_000_000) {
        await reader.cancel();
        throw new RemovalRefused(413);
      }
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

/** Browser sessions have no authority here. The existing release signer binds every exact request. */
export async function handleImportRemoval(
  request: Request,
  operation: ImportRemoval,
  secret: string,
  target: string,
) {
  try {
    if (request.method !== "POST") throw new RemovalRefused(405);
    const body = Schema.decodeUnknownSync(Schema.Struct({ envelope: Schema.String }))(
      await boundedBody(request),
    );
    const decoded = await openEnvelope(secret, "sbops1", body.envelope);
    if (decoded === null || decoded === undefined) throw new RemovalRefused(401);
    const signed = Schema.decodeUnknownSync(Signed)(decoded);
    const now = Date.now();
    if (
      signed.target !== target ||
      new URL(target).protocol !== "https:" ||
      new URL(target).origin !== target ||
      signed.id.length > 128 ||
      signed.at > now + 5_000 ||
      signed.expiresAt <= now ||
      signed.expiresAt > signed.at + 60_000
    )
      throw new RemovalRefused(401);
    const result = await operation.run(
      signed.operation.action,
      signed.operation.request,
      signed.operation.recipient,
      target,
      signed.operation,
    );
    return Response.json(result, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return Response.json(
      {
        error: "operation_refused",
        failure: { format: "basalt-production-ops-failure-v1", category: "unknown", phase: "sql" },
      },
      {
        status: error instanceof RemovalRefused ? error.status : 409,
        headers: { "Cache-Control": "no-store" },
      },
    );
  }
}
