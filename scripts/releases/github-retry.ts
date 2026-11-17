import { setTimeout } from "node:timers/promises";

// GitHub's API answers brief gateway failures that are gone a second later. A release must not
// fail on one, and must still fail closed once a short budget shows the outage is real. Unlike
// github-read.ts, this wraps callers that own their status handling, so 500, 429 and rate-limit
// 403s still reach them on the first attempt.
const transientStatuses = new Set([502, 503, 504]);
const resetCodes = new Set([
  "ECONNRESET",
  "ETIMEDOUT",
  "EPIPE",
  "EAI_AGAIN",
  "UND_ERR_SOCKET",
  "UND_ERR_CONNECT_TIMEOUT",
]);

export type GitHubRetryOptions = {
  attempts?: number;
  baseDelayMs?: number;
  sleep?: (milliseconds: number) => Promise<unknown>;
  random?: () => number;
  log?: (line: string) => void;
  /** Only requests that are safe to send twice retry: a replayed write can duplicate state. */
  replayable?: (method: string, url: URL, init?: RequestInit) => boolean;
};

export const readsOnly: NonNullable<GitHubRetryOptions["replayable"]> = (method) =>
  method === "GET" || method === "HEAD";

/**
 * Retries a replayable GitHub request after a 502/503/504 or a connection reset, with jittered
 * exponential backoff. The last response or error is returned unchanged, so callers keep their
 * exact failure messages and still fail closed.
 */
export function retryGitHubReads<Input extends string | URL | Request>(
  fetcher: (input: Input, init: RequestInit) => Promise<Response>,
  options: GitHubRetryOptions = {},
): (input: Input, init?: RequestInit) => Promise<Response> {
  const attempts = options.attempts ?? 3;
  const baseDelayMs = options.baseDelayMs ?? 1_000;
  const sleep = options.sleep ?? setTimeout;
  const random = options.random ?? Math.random;
  const log = options.log ?? ((line: string) => console.error(line));
  const replayable = options.replayable ?? readsOnly;
  return async (input, init = {}) => {
    const request = input instanceof Request ? input : undefined;
    const method = (init.method ?? request?.method ?? "GET").toUpperCase();
    const url = new URL(request?.url ?? String(input));
    if (!replayable(method, url, init)) return fetcher(input, init);
    const label = `GitHub read ${method} ${url.host}${url.pathname}`;
    for (let attempt = 1; ; attempt++) {
      let cause: string;
      try {
        const response = await fetcher(input, init);
        if (!transientStatuses.has(response.status)) return response;
        cause = `HTTP ${response.status}`;
        if (attempt === attempts) {
          log(`${label} failed after ${attempts} attempts (${cause})`);
          return response;
        }
        await response.body?.cancel().catch(() => undefined);
      } catch (error) {
        const code = resetCode(error);
        if (code === undefined || init.signal?.aborted || request?.signal.aborted) throw error;
        cause = code;
        if (attempt === attempts) {
          log(`${label} failed after ${attempts} attempts (${cause})`);
          throw error;
        }
      }
      const delay = Math.round(baseDelayMs * 2 ** (attempt - 1) * (0.5 + random() / 2));
      log(`${label} attempt ${attempt}/${attempts} failed (${cause}); retrying in ${delay} ms`);
      await sleep(delay);
    }
  };
}

function resetCode(error: unknown): string | undefined {
  let value = error;
  for (let depth = 0; depth < 3 && typeof value === "object" && value !== null; depth++) {
    if ("code" in value && typeof value.code === "string" && resetCodes.has(value.code))
      return value.code;
    value = "cause" in value ? value.cause : undefined;
  }
  return undefined;
}
