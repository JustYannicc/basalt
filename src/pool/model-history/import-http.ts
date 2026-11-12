import { fail } from "../json.ts";
import { historyCaller, type HistoryAccess } from "./http.ts";
import { importBody, importFailure, importUsagePage, type ImportAccess } from "./import-page.ts";

export const modelImportPath = "/pool/v1/usage/import";

export async function handleUsageImport(
  request: Request,
  access: HistoryAccess & ImportAccess,
): Promise<Response> {
  try {
    const { claims, caller, canManage } = await historyCaller(request, access);
    if (!canManage) return fail(403, "not_owner", "Only a pool manager can import usage history.");
    if (request.method !== "POST")
      return fail(404, "not_found", "This pool endpoint does not exist.");
    return await importUsagePage(await importBody(request), { pool: claims.pool, caller }, access);
  } catch (error) {
    return importFailure(error);
  }
}
