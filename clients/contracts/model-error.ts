/**
 * Model routes where sending a call again costs at most the tokens of one model response, or
 * nothing. Only these are replayed or told to retry after an unknown outcome. A route that starts
 * a job or makes a paid artifact (images, video, speech) is never on it: the provider may already
 * have accepted the first call. A new route is not replayed until it is added here.
 */
const replayablePaths = new Set([
  "/v1/messages",
  "/v1/messages/count_tokens",
  "/v1/responses",
  "/v1/responses/compact",
  "/v1/chat/completions",
  "/v1/completions",
  "/v1/embeddings",
  "/v1/models",
  "/typesafe/v1/models",
  "/messages",
  "/chat/completions",
  "/completions",
]);
const generateContent =
  /^\/v1beta\/models\/[A-Za-z0-9._-]+:(?:streamGenerateContent|generateContent)$/;

export function modelCallReplayable(pathname: string): boolean {
  return replayablePaths.has(pathname) || generateContent.test(pathname);
}

/**
 * A model call cut after dispatch has an unknown outcome. On a replayable route the client is
 * told to retry, because Claude Code stops a turn on `x-should-retry: false` and a repeat costs
 * only tokens; the pool records each attempt on its own. Every other route, and a caller that
 * does not name its route, keeps the cautious answer so the client decides.
 */
export function upstreamOutcomeUnknown(
  requestId = crypto.randomUUID(),
  pathname?: string,
): Response {
  const replayable = pathname !== undefined && modelCallReplayable(pathname);
  return Response.json(
    {
      error: {
        code: "upstream_outcome_unknown",
        type: "server_error",
        retryable: replayable,
        message: replayable
          ? "The model request was interrupted before its answer. Retry it."
          : "The request may have reached upstream. Its outcome is unknown. Do not retry automatically.",
      },
    },
    {
      status: 502,
      headers: {
        "Cache-Control": "no-store",
        "X-Request-Id": requestId,
        ...(replayable ? { "Retry-After": "1" } : { "x-should-retry": "false" }),
      },
    },
  );
}

/** The request is proven not to have been sent upstream. */
export class ModelRequestNotSent extends Error {}

/** Invalid local input cannot become valid by retrying it. */
export class LocalRequestRefused extends Error {}
