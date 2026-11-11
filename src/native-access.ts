import { waitForRetryAfter } from "../clients/contracts/retry-after.ts";

/** Internal validation is the same repeatable read as the device's preflight. */
export async function readNativeAuthorization(
  request: Request,
  env: { TOOLS_SERVICE: { fetch(request: Request): Promise<Response> } },
) {
  for (;;) {
    request.signal.throwIfAborted();
    const response = await env.TOOLS_SERVICE.fetch(
      new Request(new URL("/api/auth/native/access", request.url), {
        headers: {
          authorization: request.headers.get("authorization")!,
          accept: "application/json",
        },
        signal: request.signal,
      }),
    );
    if (response.status !== 429) return response;
    await response.body?.cancel();
    await waitForRetryAfter(response.headers, request.signal);
  }
}
