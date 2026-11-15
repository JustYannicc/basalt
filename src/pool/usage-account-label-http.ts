import { fail, failureResponse, json, object, readBody } from "./json.ts";
import { openEnvelope } from "./token.ts";

export const usageAccountLabelPath = "/pool/v1/setUsageAccountLabel";

/** The host holds the current manager lock until the durable write is acknowledged. */
export async function handleUsageAccountLabel(
  request: Request,
  access: {
    signingKey: string;
    previousSigningKey?: string;
    set: (pool: string, input: unknown) => Promise<{ success: true }>;
  },
): Promise<Response> {
  try {
    if (request.method !== "POST")
      return fail(404, "not_found", "This pool endpoint does not exist.");
    const bytes = await readBody(request, 16_384);
    if (bytes === undefined)
      return fail(413, "invalid_query", "The label assertion exceeds its limit.");
    const body: unknown = JSON.parse(new TextDecoder().decode(bytes));
    const payload =
      object(body) && typeof body.envelope === "string"
        ? await openEnvelope(access.signingKey, "sbs1", body.envelope, access.previousSigningKey)
        : undefined;
    if (
      !object(payload) ||
      payload.action !== "setUsageAccountLabel" ||
      payload.canManage !== true ||
      typeof payload.expiresAt !== "number" ||
      payload.expiresAt <= Date.now() ||
      payload.expiresAt > Date.now() + 30_000 ||
      typeof payload.pool !== "string" ||
      !payload.pool ||
      typeof payload.user !== "string" ||
      !payload.user ||
      typeof payload.organization !== "string" ||
      !payload.organization
    )
      return fail(401, "unauthorized", "A valid host manager assertion is required.");
    return json(await access.set(payload.pool, payload.input));
  } catch (error) {
    if (error instanceof SyntaxError)
      return json({ error: "invalid_query", message: "Provide a valid label assertion." }, 400);
    return failureResponse(error);
  }
}
