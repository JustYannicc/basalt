import { hostAssertionTtlMs, openEnvelope, signEnvelope } from "./token.ts";

/**
 * The router's name for one model call and which send of it this is. Every send of a call carries
 * the same request id, so a send the router repeats after the pool was lost finishes the History
 * row the first send started, and the caller's X-Request-Id names that row. Signed, because a
 * caller who chose the id could finish or shadow another call's row.
 */
export const routerAttemptHeader = "x-signalbox-router-attempt";
const routerAttemptPrefix = "sbra1";
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export interface RouterAttempt {
  requestId: string;
  attempt: number;
}

export function signRouterAttempt(secret: string, value: RouterAttempt) {
  return signEnvelope(secret, routerAttemptPrefix, {
    ...value,
    expiresAt: Date.now() + hostAssertionTtlMs,
  });
}

/** The attempt a request names in a valid, live envelope; anything else names none. */
export async function openRouterAttempt(
  request: Request,
  secret: string,
  previousSecret?: string,
): Promise<RouterAttempt | undefined> {
  const envelope = request.headers.get(routerAttemptHeader);
  if (!envelope) return undefined;
  const value = await openEnvelope(secret, routerAttemptPrefix, envelope, previousSecret).catch(
    () => undefined,
  );
  if (typeof value !== "object" || value === null) return undefined;
  const { requestId, attempt, expiresAt } = value as Record<string, unknown>;
  if (
    typeof requestId !== "string" ||
    !uuid.test(requestId) ||
    !Number.isSafeInteger(attempt) ||
    (attempt as number) < 1 ||
    typeof expiresAt !== "number" ||
    expiresAt <= Date.now()
  )
    return undefined;
  return { requestId, attempt: attempt as number };
}
