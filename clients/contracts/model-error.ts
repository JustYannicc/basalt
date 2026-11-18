/**
 * A model call cut after dispatch has an unknown outcome. Sending it again costs only tokens, and
 * the pool records each attempt on its own, so the client is told to retry: Claude Code stops a
 * turn on `x-should-retry: false` and retries any other 5xx by itself. Tools keep their own
 * not-replayed answer, because a repeated tool call can act twice.
 */
export function upstreamOutcomeUnknown(requestId = crypto.randomUUID()): Response {
  return Response.json(
    {
      error: {
        code: "upstream_outcome_unknown",
        type: "server_error",
        retryable: true,
        message: "The model request was interrupted before its answer. Retry it.",
      },
    },
    {
      status: 502,
      headers: {
        "Cache-Control": "no-store",
        "Retry-After": "1",
        "X-Request-Id": requestId,
      },
    },
  );
}

/** The request is proven not to have been sent upstream. */
export class ModelRequestNotSent extends Error {}

/** Invalid local input cannot become valid by retrying it. */
export class LocalRequestRefused extends Error {}
