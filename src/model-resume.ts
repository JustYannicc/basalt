import { routerAttemptHeader, signRouterAttempt } from "./pool/router-attempt.ts";
import { openResumeStamp, routerResumeHeader, routerResumePath } from "./pool/router-resume.ts";
import {
  resumableAnswer,
  streamBootHeader,
  streamResumeHeader,
  streamResumeTargetHeader,
  streamResumeVersion,
} from "./pool/stream-resume.ts";

/** As the entry waits before each re-attach (controller-reset.ts). */
export const routerResumeDelayMs = 1_000;

interface Resumer {
  POOL_SERVICE: { fetch(request: Request): Promise<Response> };
  POOL_APP_SIGNING_KEY: string;
}

/**
 * A streamed answer the entry stamped resumable. When its body breaks, which from here is the pool
 * Worker's isolate going down under the entry, the router re-attaches through the pool's resume
 * route from the bytes it delivered and splices the rest in, within the entry's own bounds (three
 * attempts inside 20 s for one cut, five cuts per answer; `stream-resume.ts`). Without a stamp, or
 * when no resume works, the answer ends exactly as it would have; the stamp never reaches a client.
 */
export async function resumeThroughRouter(
  response: Response,
  request: Request,
  env: Resumer,
  requestId: string,
  nextAttempt: () => number,
  wait: (milliseconds: number, signal: AbortSignal) => Promise<void>,
): Promise<Response> {
  const value = response.headers.get(routerResumeHeader);
  if (value === null) return response;
  const headers = new Headers(response.headers);
  headers.delete(routerResumeHeader);
  const stamp = await openResumeStamp(value, env.POOL_APP_SIGNING_KEY);
  const init = { status: response.status, statusText: response.statusText, headers };
  if (!stamp || stamp.requestId !== requestId) return new Response(response.body, init);
  // The entry's own splice reads these; here they come from the stamp and are stripped by it.
  headers.set(streamResumeHeader, streamResumeVersion);
  headers.set(streamResumeTargetHeader, stamp.target);
  headers.set(streamBootHeader, stamp.boot);
  headers.set("X-Request-Id", requestId);
  return resumableAnswer(new Response(response.body, init), {
    resume: async (input) =>
      env.POOL_SERVICE.fetch(
        new Request(new URL(routerResumePath, request.url), {
          method: "POST",
          headers: {
            "content-type": "application/json",
            [routerAttemptHeader]: await signRouterAttempt(env.POOL_APP_SIGNING_KEY, {
              requestId,
              attempt: nextAttempt(),
            }),
          },
          body: JSON.stringify({ stamp: value, from: input.from }),
          signal: request.signal,
        }),
      ),
    // From the router every broken body is the pool going down; a cut the layer cannot serve
    // answers gone, and the original error ends the stream as it would have.
    ended: () => true,
    wait,
    now: Date.now,
    delayMs: routerResumeDelayMs,
    signal: request.signal,
  });
}
