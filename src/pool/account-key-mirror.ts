import type { HomeClient } from "./control.ts";
import { failureResponse, json, object, readBody, unavailable } from "./json.ts";
import { openEnvelope } from "./token.ts";

export const accountMirrorPath = "/pool/v1/account-mirrors";
export const accountMirrorPrefix = "sbam1";
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** Only a fresh assertion from the trusted host can copy account fields into Home. */
export async function handleAccountKeyMirror(request: Request, input: {
  readonly home: HomeClient;
  readonly signingKey: string;
  readonly previousSigningKey?: string;
  readonly now?: () => number;
}): Promise<Response> {
  try {
    if (request.method !== "POST") return new Response(null, { status: 405 });
    const raw = await readBody(request, 65_536);
    if (raw === undefined) return new Response(null, { status: 413 });
    const body: unknown = JSON.parse(new TextDecoder().decode(raw));
    const value = object(body) && typeof body.envelope === "string"
      ? await openEnvelope(input.signingKey, accountMirrorPrefix, body.envelope, input.previousSigningKey)
      : undefined;
    const now = input.now?.() ?? Date.now();
    if (!object(value) || typeof value.at !== "number" || !Number.isFinite(value.at) || value.at > now
      || typeof value.expiresAt !== "number" || !Number.isFinite(value.expiresAt)
      || value.expiresAt <= now || value.expiresAt > now + 30_000
      || typeof value.reference !== "string" || !uuid.test(value.reference)
      || !["upsert", "remove"].includes(String(value.action))) return new Response(null, { status: 401 });
    if (value.action === "remove") {
      const response = await input.home.response(`/credentials?id=${encodeURIComponent(value.reference)}`, { method: "DELETE", signal: request.signal });
      if (!response.ok && response.status !== 404) return unavailable();
    } else {
      if (!object(value.credential) || typeof value.credential.type !== "string" || !value.credential.type
        || "uuid" in value.credential || "id" in value.credential) return new Response(null, { status: 400 });
      const saved = await input.home.data("/credentials", { method: "POST", signal: request.signal,
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ...value.credential, uuid: value.reference }) });
      if (saved.name !== `${value.reference}.json`) return unavailable();
    }
    return json(null);
  } catch (error) { return failureResponse(error); }
}
