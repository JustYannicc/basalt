import type { BucketProvider } from "./declared-buckets.ts";
import { BarrierRefusal } from "./manifest.ts";
import { safeProviderFailure } from "./operation-failure.ts";

export interface BucketRead {
  readonly fqn: string;
  readonly attempt: number;
  readonly at: string;
  /** "ok", "refused" for a read that observed a refusal, or the failure's closed provider type. */
  readonly outcome: string;
  /** The barrier's own closed refusal reason, for a read that observed one. */
  readonly refusal?: string;
  readonly reason?: string;
  readonly status?: number;
}

export interface BucketReadOptions {
  readonly record?: (read: BucketRead) => Promise<void>;
  readonly wait?: (milliseconds: number) => Promise<void>;
  readonly random?: () => number;
}

export const bucketReadAttempts = 3;
// A stalled or overloaded provider answer passes on a rerun minutes later; two short retries with
// 0-20% jitter wait 3-3.6 seconds in all, within one release step.
const retryDelay = (attempt: number, random: () => number) =>
  Math.floor(1000 * 2 ** (attempt - 1) * (1 + random() * 0.2));

/** Failures a later read can clear. Policy drift, missing access and malformed answers are final. */
const transient = new Set([
  "TimeoutError",
  "InternalServerError",
  "BadGateway",
  "ServiceUnavailable",
  "GatewayTimeout",
  "TooManyRequests",
  "CloudflareRateLimited",
  "Locked",
]);
const retryable = (failure: ReturnType<typeof safeProviderFailure>) =>
  transient.has(failure.type) ||
  (failure.type === "HttpClientError" && failure.reason === "TransportError");

/** Recording must never fail a release, so only a closed reason is copied. */
const closedReason = /^[a-z0-9-]{1,80}$/u;

const pause = (milliseconds: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, milliseconds));

/**
 * Only the read-only bucket read retries; creating and configuring a bucket stay single attempts.
 * Every attempt is recorded with its closed type before it can permit progress or another attempt.
 */
export function retryingBucketReads(
  provider: BucketProvider,
  options: BucketReadOptions = {},
): BucketProvider {
  return {
    ...provider,
    async read(target, fqn) {
      for (let attempt = 1; ; attempt++) {
        const result = await provider.read(target, fqn).then(
          (value) => ({ ok: true as const, value }),
          (error: unknown) => ({ ok: false as const, error }),
        );
        const refused = !result.ok && result.error instanceof BarrierRefusal;
        const failure = result.ok || refused ? undefined : safeProviderFailure(result.error);
        await options.record?.({
          fqn,
          attempt,
          at: new Date().toISOString(),
          // A refusal is the observation itself (policy drift, an unknown location): final, with its
          // exact change in the refusal and its closed reason here.
          outcome: refused ? "refused" : (failure?.type ?? "ok"),
          ...(refused && closedReason.test((result.error as BarrierRefusal).reason)
            ? { refusal: (result.error as BarrierRefusal).reason }
            : {}),
          ...(failure?.reason === undefined ? {} : { reason: failure.reason }),
          ...(failure?.status === undefined ? {} : { status: failure.status }),
        });
        if (result.ok) return result.value;
        if (refused) throw result.error;
        if (!retryable(failure!) || attempt === bucketReadAttempts) throw result.error;
        await (options.wait ?? pause)(retryDelay(attempt, options.random ?? Math.random));
      }
    },
  };
}
