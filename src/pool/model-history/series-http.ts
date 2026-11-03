import { fail, failureResponse, json, object, readBody } from "../json.ts";
import { openEnvelope } from "../token.ts";
import { withHistoryDatabase } from "./database.ts";
import { HistoryInputError, historyObject } from "./record.ts";
import { seriesAuthority } from "./series-input.ts";
import { poolUsageSeries } from "./series.ts";
import { lastSuccessAt } from "./last-success.ts";

export const poolUsageSeriesPath = "/__setup/v1/poolUsageSeries";
export const lastSuccessAtPath = "/__setup/v1/lastSuccessAt";

/** Native host policy authorizes this exact signed read while holding its organization lock. */
export async function handleUsageSeries(
  request: Request,
  access: {
    signingKey: string;
    previousSigningKey?: string;
    connectionString: string | undefined;
  },
): Promise<Response> {
  try {
    if (request.method !== "POST")
      return fail(404, "not_found", "This pool endpoint does not exist.");
    const bytes = await readBody(request, 2_097_152);
    if (bytes === undefined)
      return fail(413, "invalid_query", "The usage assertion exceeds its limit.");
    const body: unknown = JSON.parse(new TextDecoder().decode(bytes));
    const payload =
      object(body) && typeof body.envelope === "string"
        ? await openEnvelope(access.signingKey, "sbs1", body.envelope, access.previousSigningKey)
        : undefined;
    const action =
      new URL(request.url).pathname === poolUsageSeriesPath ? "poolUsageSeries" : "lastSuccessAt";
    if (
      !object(payload) ||
      payload.action !== action ||
      typeof payload.expiresAt !== "number" ||
      payload.expiresAt <= Date.now() ||
      payload.expiresAt > Date.now() + 30_000
    )
      return fail(401, "unauthorized", "A valid host usage assertion is required.");
    const input = historyObject(payload.input),
      authority = seriesAuthority(payload.authority);
    if (
      input.pool !== payload.pool ||
      typeof payload.user !== "string" ||
      !payload.user ||
      typeof payload.organization !== "string" ||
      !payload.organization
    )
      throw new HistoryInputError();
    const result =
      action === "poolUsageSeries"
        ? await withHistoryDatabase(access.connectionString, (db) =>
            poolUsageSeries(db, input, authority),
          )
        : await withHistoryDatabase(access.connectionString, (db) =>
            lastSuccessAt(db, input, authority),
          );
    return json(result);
  } catch (error) {
    if (error instanceof HistoryInputError || error instanceof SyntaxError)
      return json(
        {
          error: "invalid_query",
          message: "Provide valid usage bounds, dimensions and a cursor for this read.",
        },
        400,
      );
    return failureResponse(error);
  }
}
