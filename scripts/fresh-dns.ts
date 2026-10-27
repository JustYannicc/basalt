/** Name-resolution failures a just-created custom domain shows until its DNS record propagates. */
const freshDnsCodes = new Set(["ENOTFOUND", "EAI_AGAIN"]);

function resolutionCode(error: unknown): string | undefined {
  const cause = error instanceof Error ? (error.cause as { code?: unknown } | undefined) : undefined;
  return typeof cause?.code === "string" ? cause.code : undefined;
}

/**
 * Retries a first request while the host does not resolve yet, up to a bounded wait. Any other
 * failure, or a resolution failure after the deadline, is thrown unchanged.
 */
export async function afterFreshDns<T>(
  request: () => Promise<T>,
  { timeoutMs = 300_000, intervalMs = 10_000, now = Date.now, sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms)) } = {},
): Promise<T> {
  const deadline = now() + timeoutMs;
  for (;;) {
    try {
      return await request();
    } catch (error) {
      const code = resolutionCode(error);
      if (!code || !freshDnsCodes.has(code) || now() >= deadline) throw error;
      console.warn(`Waiting for the new hostname to resolve (${code})`);
      await sleep(intervalMs);
    }
  }
}
