/** A transport failure after dispatch cannot authorize another inference attempt. */
export function upstreamOutcomeUnknown(requestId = crypto.randomUUID()): Response {
  return Response.json({ error: {
    code: "upstream_outcome_unknown", type: "server_error", retryable: false,
    message: "The request may have reached upstream. Its outcome is unknown. Do not retry automatically.",
  } }, { status: 502, headers: {
    "Cache-Control": "no-store", "X-Request-Id": requestId,
    "x-should-retry": "false",
  } });
}

/** The peer explicitly refused the operation before dispatch. */
export class ModelRequestNotSent extends Error {}
