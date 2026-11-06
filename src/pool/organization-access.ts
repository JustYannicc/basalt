import { fail, unavailable } from "./json.ts";
import { signEnvelope, verifyPoolToken } from "./token.ts";

/** Retained tokens prove identity, but only the host can say the organization still exists. */
export async function requireActivePoolOrganization(
  request: Request,
  input: {
    readonly signingKey: string;
    readonly previousSigningKey?: string;
    readonly tools: { fetch(input: string, init: RequestInit): Promise<Response> };
  },
): Promise<void> {
  const bearer = /^Bearer (\S+)$/i.exec(request.headers.get("authorization") ?? "")?.[1];
  const claims = bearer
    ? await verifyPoolToken(input.signingKey, bearer, input.previousSigningKey)
    : undefined;
  // Existing handlers own missing or invalid credentials and other token kinds.
  if (!claims) return;
  const now = Date.now();
  const envelope = await signEnvelope(input.signingKey, "sbq1", {
    pool: claims.pool,
    organization: claims.organization,
    at: now,
    expiresAt: now + 30_000,
  });
  const response = await input.tools.fetch("https://tools/api/internal/pool-organization", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ envelope }),
    signal: AbortSignal.timeout(10_000),
  });
  await response.body?.cancel();
  if (response.status === 403)
    fail(403, "unauthorized", "This organization is no longer available.");
  if (response.status !== 204) unavailable();
}
