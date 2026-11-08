import { BarrierRefusal } from "./manifest.ts";
import { deployEnvironment } from "../environment.ts";

export const readOnlySecretNames = [
  "BASALT_PREFLIGHT_STATE_URL",
  "BASALT_PREFLIGHT_STATE_TOKEN",
  "BASALT_PREFLIGHT_CLOUDFLARE_API_TOKEN",
  "BASALT_PREFLIGHT_PLANETSCALE_API_TOKEN_ID",
  "BASALT_PREFLIGHT_PLANETSCALE_API_TOKEN",
] as const;

/** The protected environment and this entry both exclude every pull-request execution. */
export function assertReadOnlyPlanContext(source: NodeJS.ProcessEnv, candidate: string) {
  if (
    source.GITHUB_ACTIONS !== "true" ||
    source.GITHUB_EVENT_NAME !== "push" ||
    source.GITHUB_REPOSITORY !== "JustYannicc/basalt" ||
    (source.GITHUB_REF !== "refs/heads/main" &&
      !source.GITHUB_REF?.startsWith("refs/heads/batch/")) ||
    !/^[a-f0-9]{40}$/u.test(candidate) ||
    candidate !== source.GITHUB_SHA
  )
    throw new BarrierRefusal("read-only-plan-untrusted-context");
}

export function readOnlyPlanEnvironment(source: NodeJS.ProcessEnv, checkout?: string) {
  for (const key of readOnlySecretNames)
    if (!source[key]?.trim()) throw new Error(`Missing protected preflight secret: ${key}`);
  // Unique names prevent an absent environment override from falling back to a deployment token.
  return deployEnvironment(
    {
      ...source,
      CLOUDFLARE_API_TOKEN: source.BASALT_PREFLIGHT_CLOUDFLARE_API_TOKEN,
      PLANETSCALE_API_TOKEN_ID: source.BASALT_PREFLIGHT_PLANETSCALE_API_TOKEN_ID,
      PLANETSCALE_API_TOKEN: source.BASALT_PREFLIGHT_PLANETSCALE_API_TOKEN,
    },
    checkout,
  );
}

/** Native providers may read control APIs; token minting and all other write methods refuse locally. */
export function readOnlyFetch(
  stateOrigin: string,
  fetcher: typeof globalThis.fetch,
  onRefusal: (refusal: BarrierRefusal) => void = () => {},
): typeof globalThis.fetch {
  const origins = new Set([
    stateOrigin,
    "https://api.cloudflare.com",
    "https://api.planetscale.com",
  ]);
  return async (input, init) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    if (request.method !== "GET") {
      const known = ["HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"].includes(request.method);
      const refusal = new BarrierRefusal("read-only-network-method", "HTTP.Request", {
        fqn: "HTTP.Request",
        type: "HTTP.Request",
        changed: [
          known
            ? { path: "method", old: "GET", new: request.method }
            : { path: "method", changed: true },
        ],
      });
      onRefusal(refusal);
      throw refusal;
    }
    if (!origins.has(url.origin) || url.protocol !== "https:") {
      const refusal = new BarrierRefusal("read-only-network-origin", "HTTP.Request", {
        fqn: "HTTP.Request",
        type: "HTTP.Request",
        changed: [{ path: "url.origin", changed: true }],
      });
      onRefusal(refusal);
      throw refusal;
    }
    return fetcher(request, { redirect: "error", credentials: "omit" });
  };
}
