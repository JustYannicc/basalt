import { object, text } from "./json.ts";
import { membershipPrefix } from "./membership-contract.ts";
import { openEnvelope } from "./token.ts";

export async function readMembershipReservation(
  request: Request,
  signingKey: string,
  previousSigningKey: string | undefined,
  clock: () => number,
) {
  if (request.method !== "POST") throw new Error("Invalid native membership acknowledgement");
  const raw = await request.text();
  if (raw.length > 8_192) throw new Error("Invalid native membership acknowledgement");
  const input: unknown = JSON.parse(raw);
  const value =
    object(input) && typeof input.envelope === "string"
      ? await openEnvelope(signingKey, membershipPrefix, input.envelope, previousSigningKey)
      : undefined;
  const now = clock();
  if (
    !object(value) ||
    !text(value.pool) ||
    !text(value.organization) ||
    !Number.isSafeInteger(value.at) ||
    !Number.isSafeInteger(value.expiresAt) ||
    Number(value.at) > now ||
    Number(value.expiresAt) <= now ||
    Number(value.expiresAt) > now + 30_000
  )
    throw new Error("Invalid native membership acknowledgement");
  return {
    pool: String(value.pool),
    organization: String(value.organization),
    at: Number(value.at),
    now,
  };
}
