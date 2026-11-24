import { callerHeader } from "../../../apps/pool/contract.ts";
import type { PoolPermissions } from "../authorization.ts";
import { digest } from "../backend-users.ts";
import { fail, failureResponse, json } from "../json.ts";
import { verifyPoolToken } from "../token.ts";
import { HistoryInputError, historyObject, timestamp } from "./record.ts";
import { readPricedRequests, type HistoryPrices } from "./priced-history.ts";
import { watchHistoryRead } from "./read-failure.ts";

export const modelHistoryPath = "/pool/v1/usage/history";

export interface HistoryAccess {
  signingKey: string;
  previousSigningKey?: string;
  connectionString: string | undefined;
  permissions: (pool: string, caller: string) => Promise<PoolPermissions | undefined>;
  currentPrices?: HistoryPrices;
}

export async function historyCaller(request: Request, access: HistoryAccess) {
  const bearer = /^Bearer (\S+)$/i.exec(request.headers.get("authorization") ?? "")?.[1];
  const claims = bearer
    ? await verifyPoolToken(access.signingKey, bearer, access.previousSigningKey)
    : undefined;
  if (!claims) return fail(401, "unauthorized", "A valid pool token is required.");
  const caller = request.headers.get(callerHeader);
  if (!caller) return fail(403, "unauthorized", "Sign in to read model history.");
  const permissions = await access.permissions(claims.pool, caller);
  if (permissions !== undefined && !permissions.canUse)
    return fail(403, "unauthorized", "This pool is not available to you.");
  return { claims, caller, canManage: permissions?.canManage ?? caller === claims.owner };
}

export async function handleModelHistory(
  request: Request,
  access: HistoryAccess,
): Promise<Response> {
  // Each statement of the page and its prices is a `history_requests_phase` line, and a read that
  // answers 5xx is one `POOL_USAGE_READ_FAILED` line naming its step, as the summary's is.
  const watch = watchHistoryRead("poolUsageHistory", "requests");
  try {
    const { claims, caller, canManage } = await historyCaller(request, access);
    if (request.method !== "GET")
      return fail(404, "not_found", "This pool endpoint does not exist.");
    const params = new URL(request.url).searchParams;
    const from = timestamp(params.get("from")),
      to = timestamp(params.get("to"));
    if (from >= to) throw new HistoryInputError();
    let after: { timestamp: string; id: string } | undefined;
    if (params.has("after")) {
      const raw = params.get("after")!;
      if (raw.length > 256) throw new HistoryInputError();
      const cursor = historyObject(JSON.parse(raw));
      if (typeof cursor.id !== "string" || !/^[a-f0-9]{64}$/.test(cursor.id))
        throw new HistoryInputError();
      after = { timestamp: timestamp(cursor.timestamp), id: cursor.id };
    }
    const pool = (await digest(claims.pool)).slice(0, 16),
      person = canManage ? undefined : await digest(caller);
    const result = await readPricedRequests(
      access.connectionString,
      {
        pool,
        person,
        from,
        to,
        after,
      },
      access.currentPrices,
      watch,
    );
    return json(result);
  } catch (error) {
    if (error instanceof HistoryInputError || error instanceof SyntaxError)
      return json(
        {
          error: "invalid_query",
          message: "Provide UTC from/to timestamps and a valid history cursor.",
        },
        400,
      );
    const response = failureResponse(error);
    watch.answered(error, response);
    return response;
  }
}
