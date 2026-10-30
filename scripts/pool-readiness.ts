export async function waitForPoolStatus(
  name: string,
  expectedStatus: number,
  request: (signal: AbortSignal) => Promise<Response>,
  {
    timeoutMs = 240_000,
    requestTimeoutMs = 15_000,
    intervalMs = 5_000,
    now = Date.now,
    sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms)),
  } = {},
): Promise<void> {
  const deadline = now() + timeoutMs;
  let lastFailure: unknown;
  while (now() < deadline) {
    try {
      const response = await request(AbortSignal.timeout(Math.max(1, Math.min(requestTimeoutMs, deadline - now()))));
      await response.body?.cancel();
      if (now() >= deadline) break;
      if (response.status === expectedStatus) return;
      lastFailure = new Error(`${name} returned HTTP ${response.status}; expected ${expectedStatus}`);
      if (response.status < 500 || response.status > 599) throw lastFailure;
    } catch (error) {
      if (!(error instanceof TypeError) &&
          !(error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError"))) throw error;
      lastFailure = error;
    }
    const remaining = deadline - now();
    if (remaining > 0) await sleep(Math.min(intervalMs, remaining));
  }
  throw new Error(`${name} did not return HTTP ${expectedStatus} within ${timeoutMs}ms`, { cause: lastFailure });
}
