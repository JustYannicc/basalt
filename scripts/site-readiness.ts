import { brand } from "../brand.ts";
import { home } from "../src/site/content.ts";

const homepageMarker = `<h1>${home.headline[0]} <em>${home.headline[1]}</em></h1>`;
const canonical = `<link rel="canonical" href="${new URL("/", brand.site.url).href}">`;

export async function waitForPublicSite(
  url: string,
  {
    timeoutMs = 180_000,
    requestTimeoutMs = 10_000,
    intervalMs = 5_000,
    request = fetch,
    now = Date.now,
    sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms)),
  } = {},
): Promise<void> {
  const deadline = now() + timeoutMs;
  let lastFailure: unknown;
  while (now() < deadline) {
    try {
      const response = await request(url, {
        redirect: "manual",
        signal: AbortSignal.timeout(Math.max(1, Math.min(requestTimeoutMs, deadline - now()))),
      });
      if (response.status === 200 && response.headers.get("content-security-policy")?.trim()) {
        const body = await response.text();
        if (now() >= deadline) break;
        if (body.includes(homepageMarker) && body.includes(canonical)) return;
        lastFailure = new Error("Public site response is missing the homepage marker or canonical URL");
      } else {
        await response.body?.cancel();
        lastFailure = new Error(`Public site returned HTTP ${response.status}${response.status === 200 ? " without Content-Security-Policy" : ""}`);
        if (response.status !== 200 && response.status !== 408 && response.status !== 429 &&
            (response.status < 500 || response.status > 599)) throw lastFailure;
      }
    } catch (error) {
      if (!(error instanceof TypeError) &&
          !(error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError"))) throw error;
      lastFailure = error;
    }
    const remaining = deadline - now();
    if (remaining > 0) await sleep(Math.min(intervalMs, remaining));
  }
  throw new Error(`Public site did not return its homepage with HTTP 200 and Content-Security-Policy within ${timeoutMs}ms`, { cause: lastFailure });
}
