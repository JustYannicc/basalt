import { fail, object, readBody } from "../json.ts";
import { openEnvelope } from "../token.ts";
import { historyObject } from "./record.ts";
import { maximumImportBytes } from "./import.ts";
import { importFailure, importUsagePage, type ImportAccess } from "./import-page.ts";

export const ownerModelImportPath = "/pool/v1/usage/import/owner";

/** The host holds its access lock while the signed owner's page is committed. */
export async function handleOwnerUsageImport(
  request: Request,
  access: ImportAccess,
): Promise<Response> {
  try {
    if (request.method !== "POST")
      return fail(404, "not_found", "This pool endpoint does not exist.");
    const bytes = await readBody(request, 3 * maximumImportBytes + 256_000);
    if (bytes === undefined)
      return fail(413, "invalid_query", "Import a smaller usage export page.");
    const body: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    const payload =
      object(body) && typeof body.envelope === "string"
        ? await openEnvelope(access.signingKey, "sbs1", body.envelope, access.previousSigningKey)
        : undefined;
    const now = Date.now();
    if (
      !object(payload) ||
      payload.action !== "importUsage" ||
      !Number.isSafeInteger(payload.expiresAt) ||
      Number(payload.expiresAt) <= now ||
      Number(payload.expiresAt) > now + 30_000 ||
      ![payload.pool, payload.organization, payload.owner, payload.user].every(
        (value) => typeof value === "string" && value.length > 0 && value.length <= 256,
      ) ||
      payload.user !== payload.owner
    )
      return fail(401, "unauthorized", "A current pool owner import assertion is required.");
    return await importUsagePage(
      historyObject(payload.input),
      {
        pool: String(payload.pool),
        caller: String(payload.user),
      },
      access,
    );
  } catch (error) {
    return importFailure(error);
  }
}
