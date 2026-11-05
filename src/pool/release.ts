import { tokenKeyVersion } from "./token.ts";
import { poolWorkerRevision } from "./worker-revision.ts";

export const poolReleasePath = "/pool/v1/release";

/**
 * What the tools service checks before it deploys a pool bundle or re-signs pool tokens: this
 * Worker's code revision and the version of its signing key. Never key material or config.
 */
export async function poolRelease(
  request: Request,
  env: { readonly POOL_APP_SIGNING_KEY: string },
  revision: string = poolWorkerRevision,
): Promise<Response> {
  if (request.method !== "GET") return new Response(null, { status: 405 });
  return Response.json(
    { revision, keyVersion: await tokenKeyVersion(env.POOL_APP_SIGNING_KEY) },
    { headers: { "Cache-Control": "no-store" } },
  );
}
