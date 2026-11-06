import { homeReferences } from "./home-references.ts";
import { object, readBody, text } from "./json.ts";
import { openEnvelope } from "./token.ts";

export const removalIntentPath = "/pool/v1/account-removal-intents";
export const removalIntentPrefix = "sbrm1";

/** Only the authenticated host may attest intent; a pool token cannot mint this receipt. */
export async function handleRemovalIntent(
  request: Request,
  input: {
    signingKey: string;
    previousSigningKey?: string;
    refresh(pool: string): Promise<void>;
    selected(pool: string): Promise<readonly string[]>;
    record(
      pool: string,
      references: readonly string[],
      actor: string,
      operation: string,
      issuedAt: number,
    ): Promise<boolean>;
    now?: () => number;
  },
): Promise<Response> {
  if (request.method !== "POST") return new Response(null, { status: 405 });
  try {
    const bytes = await readBody(request, 8192);
    if (bytes === undefined) return new Response(null, { status: 413 });
    const body: unknown = JSON.parse(new TextDecoder().decode(bytes));
    const value =
      object(body) && typeof body.envelope === "string"
        ? await openEnvelope(
            input.signingKey,
            removalIntentPrefix,
            body.envelope,
            input.previousSigningKey,
          )
        : undefined;
    const now = input.now?.() ?? Date.now();
    if (
      !object(value) ||
      value.audience !== removalIntentPath ||
      !text(value.pool) ||
      !text(value.actor) ||
      !text(value.reference) ||
      !text(value.operation) ||
      String(value.actor).startsWith("organization:") ||
      [value.pool, value.actor, value.operation].some((value) => String(value).length > 255) ||
      typeof value.at !== "number" ||
      !Number.isSafeInteger(value.at) ||
      value.at > now ||
      typeof value.expiresAt !== "number" ||
      !Number.isSafeInteger(value.expiresAt) ||
      value.expiresAt <= now ||
      value.expiresAt <= value.at ||
      value.expiresAt - value.at > 30_000
    )
      return new Response(null, { status: 401 });
    const references = homeReferences(String(value.reference));
    await input.refresh(String(value.pool));
    const selected = new Set(await input.selected(String(value.pool)));
    if (references.some((reference) => selected.has(reference)))
      return new Response(null, { status: 409 });
    const recorded = await input.record(
      String(value.pool),
      references,
      String(value.actor),
      String(value.operation),
      value.at,
    );
    return new Response(null, { status: recorded ? 204 : 409 });
  } catch {
    return Response.json({ error: "removal_intent_unavailable" }, { status: 503 });
  }
}
