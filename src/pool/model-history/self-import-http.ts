import type { UsageImportResult } from "../../../apps/pool/import-contract.ts";
import { digest } from "../backend-users.ts";
import { fail, json, readBody, failureResponse } from "../json.ts";
import { openEnvelope, signEnvelope } from "../token.ts";
import { HistoryConflict, existingRequests, insertRequests, recordValues } from "./store.ts";
import { HistoryInputError, historyObject } from "./record.ts";
import { maximumImportBytes } from "./import.ts";
import { historyCaller, type HistoryAccess } from "./http.ts";
import { withHistoryDatabase } from "./database.ts";
import { prepareSelfImport, validateSelfImportPage } from "./self-import.ts";

export const selfModelImportPath = "/pool/v1/usage/import/self";

const approvalPrefix = "sbsi1";
const approvalLifetime = 15 * 60_000;
const maximumBodyBytes = 2 * maximumImportBytes + 128_000;

class SelfImportApprovalError extends Error {}

async function readImportPage(request: Request) {
  const bytes = await readBody(request, maximumBodyBytes);
  if (bytes === undefined)
    return fail(413, "invalid_query", "Import a smaller usage metadata page.");
  return validateSelfImportPage(
    historyObject(
      JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes)),
    ),
  );
}

export async function handleSelfUsageImport(
  request: Request,
  access: HistoryAccess,
): Promise<Response> {
  try {
    const { claims, caller, canManage } = await historyCaller(request, access);
    if (!canManage) return fail(403, "not_owner", "Only a pool manager can import usage history.");
    if (request.method !== "POST")
      return fail(404, "not_found", "This pool endpoint does not exist.");

    const input = await readImportPage(request);
    const prepared = await prepareSelfImport(input, { pool: claims.pool, caller });
    const now = Date.now();
    const summaryDigest = await digest(
      JSON.stringify({
        format: prepared.format,
        offset: prepared.offset,
        records: prepared.records.map((row) => recordValues(row)),
        totalDetails: prepared.totalDetails,
        aggregateOnlyNotImportable: prepared.aggregateOnlyNotImportable,
        indistinguishableDetails: prepared.indistinguishableDetails,
      }),
    );
    const result = await withHistoryDatabase(access.connectionString, async (db) => {
      await db.query(input.mode === "dry-run" ? "BEGIN TRANSACTION READ ONLY" : "BEGIN");
      try {
        await db.query("SET LOCAL lock_timeout = '500ms'");
        await db.query("SET LOCAL statement_timeout = '5s'");
        if (input.mode === "apply") {
          const token =
            input.approval === undefined
              ? undefined
              : await openEnvelope(
                  access.signingKey,
                  approvalPrefix,
                  input.approval,
                  access.previousSigningKey,
                );
          const approval = token === undefined ? undefined : historyObject(token);
          if (
            approval?.digest !== summaryDigest ||
            approval.pool !== claims.pool ||
            approval.caller !== caller ||
            typeof approval.expiresAt !== "number" ||
            approval.expiresAt <= now ||
            approval.expiresAt > now + approvalLifetime
          )
            throw new SelfImportApprovalError();
        }
        const existing = await existingRequests(db, prepared.records, false, true);
        const inserted =
          input.mode === "apply" ? await insertRequests(db, prepared.records, false, true) : 0;
        await db.query("COMMIT");
        return {
          existing: existing.size,
          wouldInsert: new Set(prepared.records.map((row) => row.id)).size - existing.size,
          inserted,
        };
      } catch (error) {
        await db.query("ROLLBACK").catch(() => {});
        throw error;
      }
    });
    const timestamps = prepared.records.map((row) => row.timestamp).sort();
    const response: UsageImportResult = {
      mode: input.mode,
      totalDetails: prepared.totalDetails,
      pageDetails: prepared.records.length,
      existing: result.existing,
      wouldInsert: result.wouldInsert,
      inserted: result.inserted,
      unpriced: prepared.records.length,
      next: prepared.next,
      approval:
        input.mode === "dry-run"
          ? await signEnvelope(access.signingKey, approvalPrefix, {
              digest: summaryDigest,
              pool: claims.pool,
              caller,
              expiresAt: now + approvalLifetime,
            })
          : null,
      from: timestamps[0] ?? null,
      to: timestamps.at(-1) ?? null,
      aggregateOnlyNotImportable: prepared.aggregateOnlyNotImportable,
      indistinguishableDetails: prepared.indistinguishableDetails,
    };
    return json(response);
  } catch (error) {
    if (error instanceof SelfImportApprovalError)
      return json(
        {
          error: "invalid_query",
          message: "Run a new dry run and approve its matching report before importing.",
        },
        409,
      );
    if (error instanceof HistoryConflict)
      return json(
        {
          error: "identity_conflict",
          message: "This usage identity conflicts with retained history.",
        },
        409,
      );
    if (
      error instanceof HistoryInputError ||
      error instanceof SyntaxError ||
      error instanceof TypeError
    )
      return json(
        {
          error: "invalid_query",
          message: "Provide one supported usage metadata page with a valid format and offset.",
        },
        400,
      );
    return failureResponse(error);
  }
}
