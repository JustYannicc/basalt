import { failureResponse, json, object, readBody } from "./json.ts";
import { openEnvelope } from "./token.ts";

export const poolChangesPath = "/pool/v1/changeRevisions";

/** The tools host already authorized the app; this service assertion cannot name another caller. */
export async function readCommittedPoolChanges(
  request: Request,
  input: {
    signingKey: string;
    previousSigningKey?: string;
    current: (pool: string) => Promise<unknown>;
    now?: () => number;
  },
): Promise<Response> {
  try {
    if (request.method !== "POST") return new Response(null, { status: 405 });
    const body = await readBody(request, 16_384);
    if (!body) return new Response(null, { status: 400 });
    const raw: unknown = JSON.parse(new TextDecoder().decode(body));
    const value =
      object(raw) && typeof raw.envelope === "string"
        ? await openEnvelope(input.signingKey, "sbs1", raw.envelope, input.previousSigningKey)
        : undefined;
    const now = input.now?.() ?? Date.now();
    if (
      !object(value) ||
      value.action !== "changeRevisions" ||
      typeof value.pool !== "string" ||
      !value.pool.length ||
      value.pool.length > 256 ||
      typeof value.expiresAt !== "number" ||
      !Number.isFinite(value.expiresAt) ||
      value.expiresAt <= now ||
      value.expiresAt > now + 30_000
    )
      return new Response(null, { status: 401 });
    return json(await input.current(value.pool));
  } catch (error) {
    return failureResponse(error);
  }
}
