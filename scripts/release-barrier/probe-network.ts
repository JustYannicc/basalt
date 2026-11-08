import { BarrierRefusal } from "./manifest.ts";

/** State authentication uses temporary preview uploads. No production or State mutation is allowed. */
export function readOnlyProbeFetch(
  accountId: string,
  nativeFetch = globalThis.fetch,
): typeof fetch {
  const prefix = `/client/v4/accounts/${encodeURIComponent(accountId)}/workers/`;
  const preview = new Set([
    `${prefix}subdomain/edge-preview`,
    `${prefix}scripts/alchemy-state-store/edge-preview`,
  ]);
  return async (input, init) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    if (
      request.method !== "GET" &&
      !(
        request.method === "POST" &&
        url.origin === "https://api.cloudflare.com" &&
        preview.has(url.pathname)
      )
    )
      throw new BarrierRefusal("forward-probe-mutation-refused");
    return nativeFetch(
      new Request(request, {
        redirect: "error",
        signal: AbortSignal.any([request.signal, AbortSignal.timeout(30_000)]),
      }),
    );
  };
}
