import { accessPrefix, accessTtl, type AccessEnvelope } from "./access-contract.ts";
import { fail, object, text } from "./json.ts";
import { openEnvelope } from "./token.ts";

const unauthorized = () => fail(401, "unauthorized", "A valid tools service access assertion is required.");
export async function readAccess(request: Request, signingKey: string, previous: string | undefined, now: number): Promise<AccessEnvelope> {
  if (request.method !== "POST") return unauthorized();
  let value: unknown;
  try {
    const raw = await request.text();
    if (raw.length > 1_000_000) return unauthorized();
    const body: unknown = JSON.parse(raw);
    value = object(body) && typeof body.envelope === "string"
      ? await openEnvelope(signingKey, accessPrefix, body.envelope, previous) : undefined;
  } catch { return unauthorized(); }
  if (!object(value) || typeof value.at !== "number" || !Number.isSafeInteger(value.at) || value.at < 0
    || typeof value.expiresAt !== "number" || !Number.isSafeInteger(value.expiresAt)
    || value.expiresAt <= now || value.expiresAt > now + accessTtl) return unauthorized();
  if (value.action === "audience") {
    if (!Array.isArray(value.pools) || !value.pools.every((pool) => object(pool)
      && text(pool.pool) && text(pool.owner) && text(pool.organization) && typeof pool.name === "string"
      && Array.isArray(pool.users) && pool.users.every((user) => text(user)))) return unauthorized();
    if (new Set(value.pools.map((pool) => pool.pool)).size !== value.pools.length) return unauthorized();
  } else if (value.action === "pool-deleted") {
    if (!text(value.pool)) return unauthorized();
  } else if (value.action === "person-deleted") {
    if (!text(value.user)) return unauthorized();
  } else return unauthorized();
  return value as unknown as AccessEnvelope;
}
