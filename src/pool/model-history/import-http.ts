import { digest } from "../backend-users.ts";
import { fail, failureResponse, json } from "../json.ts";
import { openEnvelope, signEnvelope } from "../token.ts";
import { withHistoryDatabase } from "./database.ts";
import { historyCaller, type HistoryAccess } from "./http.ts";
import { resolveImportIdentity } from "./import-identity.ts";
import { maximumImportBytes, parseUsageImport } from "./import.ts";
import { HistoryInputError, historyObject } from "./record.ts";
import { existingRequests, HistoryConflict, insertRequests, recordValues } from "./store.ts";

export const modelImportPath = "/pool/v1/usage/import";
class ImportApprovalError extends Error {}

const approvalPrefix = "sbmi1";
const approvalLifetime = 15 * 60_000;

async function importBody(request: Request): Promise<Record<string, unknown>> {
  if (!request.body) throw new HistoryInputError();
  const reader = request.body.getReader(), parts: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 2 * maximumImportBytes + 128_000) {
        await reader.cancel();
        return fail(413, "invalid_query", "Import a smaller usage export page.");
      }
      parts.push(value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const part of parts) { bytes.set(part, offset); offset += part.byteLength; }
  return historyObject(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)));
}

export async function handleUsageImport(request: Request, access: HistoryAccess): Promise<Response> {
  try {
    const { claims, caller, canManage } = await historyCaller(request, access);
    if (!canManage) return fail(403, "not_owner", "Only a pool manager can import usage history.");
    if (request.method !== "POST") return fail(404, "not_found", "This pool endpoint does not exist.");
    const input = await importBody(request), mode = input.mode ?? "dry-run";
    if (mode !== "dry-run" && mode !== "apply") throw new HistoryInputError();
    const parsed = await parseUsageImport(input, { pool: claims.pool, person: caller });
    const now = Date.now();
    const result = await withHistoryDatabase(access.connectionString, async (db) => {
      await db.query(mode === "dry-run" ? "BEGIN TRANSACTION READ ONLY" : "BEGIN");
      try {
        await db.query("SET LOCAL lock_timeout = '500ms'");
        await db.query("SET LOCAL statement_timeout = '5s'");
        const records = await resolveImportIdentity(db, parsed.records, parsed.local, parsed.homeUsageIds);
        const resolvedDigest = await digest(JSON.stringify({ input: parsed.digest, records: records.map(recordValues) }));
        if (mode === "apply") {
          const token = typeof input.approval === "string" ? await openEnvelope(access.signingKey, approvalPrefix,
            input.approval, access.previousSigningKey) : undefined;
          const approval = token === undefined ? undefined : historyObject(token);
          if (!approval || approval.digest !== resolvedDigest || approval.pool !== claims.pool || approval.caller !== caller
            || typeof approval.expiresAt !== "number" || approval.expiresAt <= now || approval.expiresAt > now + approvalLifetime)
            throw new ImportApprovalError();
        }
        const existing = await existingRequests(db, records);
        const inserted = mode === "apply" ? await insertRequests(db, records) : 0;
        await db.query("COMMIT");
        return { existing: existing.size, wouldInsert: new Set(records.map((row) => row.id)).size - existing.size, inserted, resolvedDigest,
          unpriced: records.filter((row) => row.cost === null).length,
          missingProvider: records.filter((row) => row.provider === null).length,
          missingEndpoint: records.filter((row) => row.endpoint === null).length,
          missingLatency: records.filter((row) => row.latencyMs === null).length,
          missingPriceSnapshot: records.filter((row) => row.price === null).length };
      } catch (error) {
        await db.query("ROLLBACK").catch(() => {});
        throw error;
      }
    });
    const { resolvedDigest, ...report } = result;
    return json({ mode, ...parsed.report, ...report, next: parsed.next,
      approval: mode === "dry-run" ? await signEnvelope(access.signingKey, approvalPrefix,
        { digest: resolvedDigest, pool: claims.pool, caller, expiresAt: now + approvalLifetime }) : null });
  } catch (error) {
    if (error instanceof ImportApprovalError) return json({ error: "invalid_query",
      message: "Run a new dry run and approve its matching report before importing." }, 409);
    if (error instanceof HistoryConflict) return json({ error: "identity_conflict", message: error.message }, 409);
    if (error instanceof HistoryInputError || error instanceof SyntaxError || error instanceof TypeError)
      return json({ error: "invalid_query", message: "Provide a supported per-request usage export and valid historical price mappings." }, 400);
    return failureResponse(error);
  }
}
