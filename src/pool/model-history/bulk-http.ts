import { fail, object, readBody } from "../json.ts";
import { openEnvelope } from "../token.ts";
import { bulkDefinition, bulkHash, bulkImportPath, type BulkIdentity } from "./bulk-contract.ts";
import { historyObject, invalidHistory } from "./record.ts";
import { importFailure } from "./import-page.ts";

export interface BulkSigningAccess {
  signingKey: string;
  previousSigningKey?: string | undefined;
}

export async function bulkCommand(request: Request, access: BulkSigningAccess) {
  if (request.method !== "POST" || new URL(request.url).pathname !== bulkImportPath)
    return invalidHistory();
  const bytes = await readBody(request, 20 * 1024 * 1024);
  if (!bytes) return invalidHistory();
  const body: unknown = JSON.parse(
    new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes),
  );
  const payload =
    object(body) && typeof body.envelope === "string"
      ? await openEnvelope(access.signingKey, "sbs1", body.envelope, access.previousSigningKey)
      : undefined;
  const now = Date.now();
  if (
    !object(payload) ||
    payload.action !== "importUsageBulk" ||
    !Number.isSafeInteger(payload.expiresAt) ||
    Number(payload.expiresAt) <= now ||
    Number(payload.expiresAt) > now + 30_000 ||
    payload.owner !== payload.user ||
    ![payload.pool, payload.organization, payload.owner].every(
      (value) => typeof value === "string" && value.length > 0 && value.length <= 256,
    )
  )
    return undefined;
  const identity: BulkIdentity = {
    pool: String(payload.pool),
    organization: String(payload.organization),
    owner: String(payload.owner),
  };
  const input = historyObject(payload.input);
  const definition =
    input.operation === "begin" ? await bulkDefinition(input, identity) : undefined;
  const job = definition?.job ?? bulkHash(input.job);
  return { identity, input, definition, job, bytes };
}

export async function routeBulkImport(
  request: Request,
  access: BulkSigningAccess & {
    jobs?: {
      jurisdiction(region: "eu"): {
        getByName(name: string): {
          fetch(input: string, init: RequestInit): Promise<Response>;
        };
      };
    };
  },
) {
  try {
    const command = await bulkCommand(request, access);
    if (!command)
      return fail(401, "unauthorized", "A current pool owner import assertion is required.");
    if (!access.jobs)
      return fail(409, "bulk_import_not_provisioned", "Bulk import is not provisioned yet.");
    const stub = access.jobs.jurisdiction("eu").getByName(`bulk-usage-import:${command.job}`);
    return await stub.fetch(request.url, {
      method: "POST",
      body: new TextDecoder().decode(command.bytes),
    });
  } catch (error) {
    return importFailure(error);
  }
}
