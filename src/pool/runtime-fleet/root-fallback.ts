import { unsentRefusal } from "../controller-unsent.ts";
import { fleetSafeRead, markRootFallbackCap } from "./retry.ts";

/*
 * What the root may take as the fleet's fallback, when no cell is ready to serve.
 *
 * The root's Home pays database time on its 6-connection main pool at each model call's admission;
 * calls in flight cost nothing more. The Home owner's repro of the root's Home (22 Nov: the root's
 * old image without 0691, 45 ms to the database behind the 5-connection pooler) measured the
 * heartbeat gap against the 20 s timeout at 8.9 s for a steady 1.5 calls a second, 11.9 s at 2.5,
 * and broken at about 3, when the root falls out and takes Home's management traffic and master
 * duties with it. Bursts of 18 and 30 on an idle Home were absorbed.
 *
 * The refill is half the last steady point with headroom (2.5 a second). The burst sits under the
 * measured 18, on the low side, because the root also carries all of Home's management traffic and
 * its master duties. Both figures come from the root's old Home: re-derive them when the root gets
 * a new image.
 *
 * Catalog reads take no token. They are safe reads the fleet already retries, and these figures
 * measure model calls. A call that fails before its send gives its token back, since a retry
 * before dispatch would otherwise pay for the same call again.
 */
export const rootFallbackPerSecond = 1.2;
export const rootFallbackBurst = 10;

const requestIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * A token bucket on new root calls: the rate starves the root's Home, not the count in flight.
 * Admitted calls wait until their send, and while the root starts they queue on its warm-up, so
 * tokens and waiting calls together never exceed a burst: the root never sees more at once.
 */
export class RootFallback {
  private tokens = rootFallbackBurst;
  private waiting = 0;
  private at: number;
  private now: () => number;
  constructor(now: () => number) {
    this.now = now;
    this.at = now();
  }
  private refill() {
    const now = this.now();
    const earned = (Math.max(0, now - this.at) / 1_000) * rootFallbackPerSecond;
    this.tokens = Math.min(rootFallbackBurst - this.waiting, this.tokens + earned);
    // A clock that steps back never rewinds the bucket, so no span is earned twice.
    this.at = Math.max(this.at, now);
  }
  /** Takes a token for a call that then waits until its send. */
  admit() {
    this.refill();
    if (this.tokens < 1) return false;
    this.tokens -= 1;
    this.waiting += 1;
    return true;
  }
  /** The admitted call sent, or ended; with `refund`, it reached nothing and its token comes back. */
  release(refund: boolean) {
    this.refill();
    this.waiting -= 1;
    if (refund) this.tokens = Math.min(rootFallbackBurst - this.waiting, this.tokens + 1);
  }
}

/**
 * The cap counts every model call, which the figures above measure, a video status poll and a model
 * socket included. Only the fleet's safe reads, the model catalog it already retries, are left out.
 */
export const rootFallbackCounts = (request: Request) => !fleetSafeRead(request);

/**
 * Nothing was sent, so the refusal is marked unsent: the entry sends a held call again each second
 * inside its replay window, and a client that isn't held gets the retryable answer it already
 * follows. One count line either way. A call held for the root's restart waits it out at the cap's
 * rate instead.
 */
export function rootFallbackRefused(request: Request) {
  const id = request.headers.get("X-Basalt-Request-Id");
  console.error(
    "POOL_ROOT_FALLBACK_REFUSED",
    JSON.stringify({ count: 1, requestId: id && requestIdPattern.test(id) ? id : null }),
  );
  return markRootFallbackCap(unsentRefusal(request), 1_000 / rootFallbackPerSecond);
}
