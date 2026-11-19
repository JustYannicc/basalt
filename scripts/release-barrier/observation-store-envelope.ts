import { BarrierRefusal } from "./manifest.ts";

export function observationStoreEnvelope(
  accountId: string,
  record: (entry: {
    phase: string;
    method: string;
    path: string;
    disposition: string;
  }) => Promise<void>,
  nativeFetch = globalThis.fetch,
) {
  const prefix = `/client/v4/accounts/${accountId}/workers/`;
  const paths = {
    createSubdomainEdgePreviewSession: `${prefix}subdomain/edge-preview`,
    createScriptEdgePreview: `${prefix}scripts/alchemy-state-store/edge-preview`,
  };
  let phase: "closed" | "auth" | "operation" = "closed";
  let violated = false;
  const counts = { createSubdomainEdgePreviewSession: 0, createScriptEdgePreview: 0 };
  let blockedMutations = 0;
  let admitted = 0;
  const assertClean = () => {
    if (violated) throw new BarrierRefusal("observation-store-network-envelope-violated");
  };
  const fetch: typeof globalThis.fetch = async (input, init) => {
    assertClean();
    const request = new Request(input, init);
    const url = new URL(request.url);
    const cloudflareApi = url.hostname.replace(/\.+$/u, "") === "api.cloudflare.com";
    const mutation = cloudflareApi && request.method !== "GET";
    const operation = Object.entries(paths).find(([, path]) => path === url.pathname)?.[0];
    const preview = cloudflareApi && url.pathname.includes("/edge-preview");
    if (mutation || preview) {
      const expectedMethod = operation === "createSubdomainEdgePreviewSession" ? "GET" : "POST";
      if (
        phase !== "auth" ||
        request.method !== expectedMethod ||
        url.origin !== "https://api.cloudflare.com" ||
        url.search ||
        url.hash ||
        url.username ||
        url.password ||
        !operation ||
        admitted >= 8
      ) {
        violated = true;
        if (mutation) blockedMutations++;
        await record({ phase, method: request.method, path: url.pathname, disposition: "blocked" });
        throw new BarrierRefusal("observation-store-cloudflare-request-refused");
      }
      admitted++;
      await record({
        phase,
        method: request.method,
        path: url.pathname,
        disposition: "allowed-auth-preview",
      });
      assertClean();
      if (phase !== "auth") {
        violated = true;
        if (mutation) blockedMutations++;
        throw new BarrierRefusal("observation-store-auth-phase-ended-before-send");
      }
      if (operation === "createSubdomainEdgePreviewSession")
        counts.createSubdomainEdgePreviewSession++;
      else counts.createScriptEdgePreview++;
    }
    return nativeFetch(
      new Request(request, {
        // Artifact downloads inspect the signed redirect before sending a credential-free GET.
        redirect: request.redirect === "manual" ? "manual" : "error",
        signal: AbortSignal.any([request.signal, AbortSignal.timeout(30_000)]),
      }),
    );
  };
  return {
    fetch,
    beginAuth: () => {
      assertClean();
      if (phase !== "closed") throw new BarrierRefusal("observation-store-auth-phase-reentered");
      phase = "auth";
    },
    endAuth: () => {
      assertClean();
      if (phase !== "auth") throw new BarrierRefusal("observation-store-auth-phase-missing");
      phase = "operation";
    },
    assertClean,
    receipt: () => ({
      format: "pool-observation-store-network-envelope-v1",
      authPreviewRequests: { ...counts },
      authPreviewPosts: counts.createScriptEdgePreview,
      otherCloudflareMutations: 0,
      blockedMutations,
    }),
  };
}
