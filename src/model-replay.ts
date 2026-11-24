import { modelCallReplayable, upstreamOutcomeUnknown } from "../clients/contracts/model-error.ts";
import { holdBody } from "./pool/held-body.ts";
import { routerAttemptHeader, signRouterAttempt } from "./pool/router-attempt.ts";
import { shape } from "./pool/runtime-fleet/endpoint-trace.ts";
import { resumeThroughRouter } from "./model-resume.ts";

/**
 * The platform can replace the pool Worker's isolate under every hop at once: the entry that holds
 * and replays a call goes down with the controller. The router outlives it, and a rejected send
 * there is the moment the pool's answer was lost. A replayable model call it holds is sent once
 * more; the second send reaches a new instance, which was back 1.4 s later on 24 Nov.
 */
export const routerReplayDelayMs = 1_000;
/** One replay: a second loss in a row is no longer a reset, and its caller keeps today's answer. */
export const routerSends = 2;
/** The entry's bound: past it a body is sent unheld and only loses its replay. */
export const routerHoldBytes = 4 * 1024 * 1024;
/** A quarter of the router's 128 MB isolate, as the entry keeps for itself. */
export const routerHoldBudgetBytes = 32 * 1024 * 1024;
/**
 * Holds end with the first answer. The router has no request signal, so a caller who hangs up cancels
 * the handler and its own release never runs; this window frees that copy. A first send that takes
 * longer before its headers is not replayed.
 */
export const routerHoldWindowMs = 120_000;
/**
 * Replays waiting or in flight in one router isolate. A pool that fails every send for everyone
 * gets at most this many extra sends per isolate at once, not one per caller; past it a call gets
 * today's answer at once. 24 Nov's reset cut 7 calls together, so a reset this size and twice
 * over is still served.
 */
export const routerReplayCeiling = 16;
// Each slot carries its own deadline, as a held copy does: a cancelled handler never frees it.
const replaying = new Map<object, number>();
function replaysInFlight() {
  const now = Date.now();
  for (const [slot, until] of replaying) if (until <= now) replaying.delete(slot);
  return replaying.size;
}

export interface ModelForward {
  POOL_SERVICE: { fetch(request: Request): Promise<Response> };
  POOL_APP_SIGNING_KEY: string;
}

type Outcome = "served" | "answered" | "failed_again" | "client_left";
type Skip =
  | "overloaded"
  | "client_left"
  | "ceiling"
  | "not_replayable"
  | "body_too_large"
  | "body_unreadable"
  | "hold_budget_full"
  | "too_late";

const sleep = (milliseconds: number, signal: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, milliseconds);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(signal.reason);
      },
      { once: true },
    );
  });

/**
 * Sends a model call to the pool. `prepare` sets per-send headers, such as a device assertion that
 * must be fresh on a late replay. The caller's answer past every bound is today's retryable 502.
 */
export async function forwardModelCall(
  request: Request,
  env: ModelForward,
  prepare: (headers: Headers) => Promise<void> = async () => {},
  wait: (milliseconds: number, signal: AbortSignal) => Promise<void> = sleep,
): Promise<Response> {
  const url = new URL(request.url);
  const endpoint = url.pathname;
  const requestId = crypto.randomUUID();
  const begun = Date.now();
  const replayable =
    request.method === "POST" && !request.headers.has("upgrade") && modelCallReplayable(endpoint);
  const copy = holdBody(
    replayable && request.body ? request.clone().body : null,
    { maxBytes: routerHoldBytes, budgetBytes: routerHoldBudgetBytes, windowMs: routerHoldWindowMs },
    () => {},
  );
  const headersFor = async (attempt: number) => {
    const headers = new Headers(request.headers);
    headers.set(
      routerAttemptHeader,
      await signRouterAttempt(env.POOL_APP_SIGNING_KEY, { requestId, attempt }),
    );
    await prepare(headers);
    return headers;
  };
  const closed = (attempts: number, outcome: Outcome | Skip, error: unknown) =>
    console.info("MODEL_FORWARD_REPLAY", {
      requestId,
      endpoint: replayable ? endpoint : "other",
      attempts,
      outcome,
      ...shape(error),
      elapsedMs: Date.now() - begun,
    });
  const lost = () => upstreamOutcomeUnknown(requestId, endpoint);
  // Sends are attempts 1 and 2; each resume of a cut stream takes the next number.
  let resumes = routerSends;
  const resumable = (answer: Response) =>
    resumeThroughRouter(answer, request, env, requestId, () => ++resumes, wait);
  try {
    // Built before the send: a signing failure is not a lost pool, and its caller keeps the 503.
    const first = new Request(request, { headers: await headersFor(1) });
    let firstError: unknown;
    try {
      return await resumable(await env.POOL_SERVICE.fetch(first));
    } catch (error) {
      firstError = error;
      console.error("MODEL_FORWARD_FAILED", {
        requestId,
        attempt: 1,
        ...shape(error),
        elapsedMs: Date.now() - begun,
      });
    }
    const failure = shape(firstError);
    // The platform says an overloaded object must not be retried; a broken pool is not reset.
    const skip: Skip | undefined = !replayable
      ? "not_replayable"
      : failure.overloaded === true
        ? "overloaded"
        : // Only the device tunnel's operation aborts its signal; a direct caller's never fires.
          request.signal.aborted
          ? "client_left"
          : replaysInFlight() >= routerReplayCeiling
            ? "ceiling"
            : undefined;
    if (skip) {
      if (replayable) closed(1, skip, firstError);
      return lost();
    }
    const slot = {};
    replaying.set(slot, Date.now() + routerHoldWindowMs);
    try {
      await copy.ready;
      const held = copy.take();
      if ("refused" in held) {
        closed(1, held.refused, firstError);
        return lost();
      }
      try {
        await wait(routerReplayDelayMs, request.signal);
      } catch {
        closed(1, "client_left", firstError);
        return lost();
      }
      try {
        const response = await env.POOL_SERVICE.fetch(
          new Request(request.url, {
            method: request.method,
            headers: await headersFor(routerSends),
            body: held.body,
            redirect: request.redirect,
            signal: request.signal,
          }),
        );
        closed(routerSends, response.ok ? "served" : "answered", firstError);
        return await resumable(response);
      } catch (error) {
        console.error("MODEL_FORWARD_FAILED", {
          requestId,
          attempt: routerSends,
          ...shape(error),
          elapsedMs: Date.now() - begun,
        });
        closed(routerSends, request.signal.aborted ? "client_left" : "failed_again", firstError);
        return lost();
      }
    } finally {
      replaying.delete(slot);
    }
  } finally {
    copy.release();
  }
}
