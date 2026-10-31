import { upstreamOutcomeUnknown } from "../../clients/contracts/model-error.ts";
import { captureError } from "../telemetry/sentry.ts";
import type { SentryEnv } from "../telemetry/sentry-target.ts";
import { withHistoryDatabase } from "./model-history/database.ts";
import { recordGatewayRefusal } from "./model-history/gateway.ts";
import { modelKeyScope } from "./key-scope.ts";

interface Dependencies extends SentryEnv {
  POOL_MODEL_HISTORY_ENABLED?: string;
  POOL_AUTH_DATABASE?: { connectionString: string };
}
export interface RefusalIdentity { pool: string; person: string | null; keyId?: number }

/** Fixed metadata joins the caller's retryable response, its failed history row and error trace. */
export function gatewayUnavailable(
  env: Dependencies,
  request: Request,
  identity: RefusalIdentity | undefined,
  started: number,
  defer: (work: Promise<unknown>) => void,
): Response {
  const requestId = crypto.randomUUID();
  const pathname = new URL(request.url).pathname;
  console.error("POOL_GATEWAY_FAILURE", { code: "pool_protection_unavailable", status: 503, requestId });
  defer(captureError(env, "pool_failure", pathname, undefined, requestId));
  if (env.POOL_MODEL_HISTORY_ENABLED === "true")
    defer((async () => {
      let caller = identity;
      if (!caller) {
        const scope = await modelKeyScope(env.POOL_AUTH_DATABASE?.connectionString, request);
        if (scope?.pools.length === 1) caller = { pool: scope.pools[0]!, person: scope.person, keyId: scope.keyId };
      }
      if (caller) await withHistoryDatabase(env.POOL_AUTH_DATABASE?.connectionString, (db) => recordGatewayRefusal(db, {
        ...caller, requestId, at: new Date().toISOString(), pathname, latencyMs: performance.now() - started,
      }));
    })().catch(() => console.error("POOL_MODEL_HISTORY_FAILURE count=1")));
  return Response.json({ error: {
    code: "pool_protection_unavailable", type: "server_error", retryable: true,
    message: "The pool's account protection is temporarily unavailable. Retry shortly.",
  } }, { status: 503, headers: {
    "Retry-After": "2", "Cache-Control": "no-store", "X-Request-Id": requestId,
  } });
}

export function gatewayOutcomeUnknown(
  env: Dependencies,
  request: Request,
  defer: (work: Promise<unknown>) => void,
): Response {
  const requestId = crypto.randomUUID();
  console.error("POOL_GATEWAY_FAILURE", { code: "upstream_outcome_unknown", status: 502, requestId });
  defer(captureError(env, "pool_failure", new URL(request.url).pathname, undefined, requestId));
  // Home may have billed this attempt, so it cannot be recorded as an uncharged refusal.
  return upstreamOutcomeUnknown(requestId);
}
