import { setTimeout } from "node:timers/promises";

export type GitHubReadOptions = {
  sleep?: (milliseconds: number) => Promise<unknown>;
  now?: () => number;
};

const attempts = 4;
const waitBudget = 120_000;

export async function readGitHubJson<T>(
  fetchImpl: typeof fetch,
  url: URL,
  init: RequestInit,
  path: string,
  options: GitHubReadOptions,
): Promise<T> {
  const sleep = options.sleep ?? setTimeout;
  const now = options.now ?? Date.now;
  let waited = 0;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    let response: Response;
    try {
      response = await fetchImpl(url, { ...init, signal: AbortSignal.timeout(15_000) });
    } catch {
      const delay = 1000 * 2 ** (attempt - 1);
      if (attempt === attempts || delay > waitBudget - waited)
        throw unavailable(path, attempt, "transport failure");
      await sleep(delay);
      waited += delay;
      continue;
    }
    if (response.ok) return (await response.json()) as T;
    const rateLimited =
      response.status === 429 ||
      (response.status === 403 &&
        (response.headers.has("retry-after") ||
          response.headers.get("x-ratelimit-remaining") === "0"));
    const retryable = rateLimited || (response.status >= 500 && response.status <= 599);
    const error = Object.assign(new Error(`GitHub API ${response.status} for ${path}`), {
      status: response.status,
    });
    const serverDelay = retryDelay(response.headers, now());
    const delay = Math.max(
      (rateLimited && serverDelay === undefined ? 60_000 : 1000) * 2 ** (attempt - 1),
      serverDelay ?? 0,
    );
    await response.body?.cancel();
    if (!retryable) throw error;
    if (attempt === attempts || delay > waitBudget - waited)
      throw unavailable(path, attempt, `HTTP ${response.status}`, response.status);
    await sleep(delay);
    waited += delay;
  }
  throw unavailable(path, attempts, "retry budget exhausted");
}

function retryDelay(headers: Headers, now: number): number | undefined {
  const retryAfter = headers.get("retry-after");
  let delay: number | undefined;
  if (retryAfter !== null) {
    const seconds = /^\d+(?:\.\d+)?$/.test(retryAfter) ? Number(retryAfter) : NaN;
    const date = Date.parse(retryAfter);
    if (Number.isFinite(seconds)) delay = seconds * 1000;
    else if (Number.isFinite(date)) delay = Math.max(0, date - now);
  }
  const reset = headers.get("x-ratelimit-reset");
  if (headers.get("x-ratelimit-remaining") === "0" && reset !== null && /^\d+$/.test(reset))
    delay = Math.max(delay ?? 0, Number(reset) * 1000 - now);
  return delay;
}

function unavailable(path: string, attempts: number, reason: string, status?: number): Error {
  return Object.assign(
    new Error(
      `GitHub API unavailable for ${path}: ${reason} after ${attempts} attempt(s); source verification could not complete. Retry later.`,
    ),
    status === undefined ? {} : { status },
  );
}
