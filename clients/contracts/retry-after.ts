/** Wait only for an idempotent authorization read; never replay application work. */
export async function waitForRetryAfter(headers: Headers, signal: AbortSignal) {
  const raw = headers.get("retry-after") ?? headers.get("x-retry-after");
  const seconds = raw === null || !raw.trim() ? NaN : Number(raw);
  const delay = Number.isFinite(seconds)
    ? seconds >= 0
      ? seconds * 1000
      : 1000
    : raw !== null && Number.isFinite(Date.parse(raw))
      ? Math.max(0, Date.parse(raw) - Date.now())
      : 1000;
  const deadline = performance.now() + delay;
  do {
    signal.throwIfAborted();
    await new Promise<void>((resolve, reject) => {
      const abort = () => {
        clearTimeout(timer);
        reject(signal.reason);
      };
      const timer = setTimeout(
        () => {
          signal.removeEventListener("abort", abort);
          resolve();
        },
        Math.min(Math.max(1, deadline - performance.now()), 2_147_483_647),
      );
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) abort();
    });
  } while (performance.now() < deadline);
}
