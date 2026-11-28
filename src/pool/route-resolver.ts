import { object } from "./json.ts";
import type { RouteAnswer, RouteResolution, RouteResolver } from "./route-assignments.ts";
import { signEnvelope } from "./token.ts";

export const routeResolutionPath = "/pool/v1/route-resolutions";
export const routeResolutionPrefix = "sbrr1";
const batch = 2_000;

class RouteResolutionFailure extends Error {}

function resolution(value: unknown): RouteResolution | undefined {
  if (!object(value)) return undefined;
  const { routeId, owner } = value;
  if (
    (routeId !== null && typeof routeId !== "string") ||
    (owner !== null && typeof owner !== "string")
  )
    return undefined;
  return { routeId, owner };
}

/**
 * The tools service resolves one pool's credential references, each under its contributor's own
 * rules. 404 means it serves no route rules yet; RouteAssignments decides what that may mean.
 * Any other failure throws, so the caller keeps its last assignments.
 */
export function toolsRouteResolver(
  service: { fetch(input: string, init: RequestInit): Promise<Response> },
  signingKey: string,
  now: () => number = Date.now,
): RouteResolver {
  async function call(
    scope: { organization: string; pool: string },
    references: readonly string[],
    signal: AbortSignal,
  ): Promise<RouteAnswer> {
    const at = now();
    const envelope = await signEnvelope(signingKey, routeResolutionPrefix, {
      action: "resolve",
      at,
      expiresAt: at + 30_000,
      organization: scope.organization,
      pool: scope.pool,
      references,
    });
    const response = await service.fetch(`https://tools${routeResolutionPath}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ envelope }),
      signal,
    });
    if (response.status === 404) {
      await response.body?.cancel();
      return {
        served: false,
        revision: 0,
        resolutions: new Map(
          references.map((reference) => [reference, { routeId: null, owner: null }]),
        ),
      };
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw new RouteResolutionFailure("route rules unavailable");
    }
    const body: unknown = await response.json();
    if (!object(body) || !Number.isSafeInteger(body.revision) || !object(body.resolutions))
      throw new RouteResolutionFailure("invalid route resolution");
    const resolutions = new Map<string, RouteResolution>();
    for (const reference of references) {
      const value = resolution(body.resolutions[reference]);
      if (value) resolutions.set(reference, value);
    }
    return { served: true, revision: body.revision as number, resolutions };
  }
  return {
    async resolve(scope, references, signal) {
      if (references.length <= batch) return call(scope, references, signal);
      let answer: RouteAnswer | undefined;
      const resolutions = new Map<string, RouteResolution>();
      for (let offset = 0; offset < references.length; offset += batch) {
        answer = await call(scope, references.slice(offset, offset + batch), signal);
        for (const [reference, value] of answer.resolutions) resolutions.set(reference, value);
      }
      return { served: answer!.served, revision: answer!.revision, resolutions };
    },
  };
}

export function routeResolver(env: {
  TOOLS_SERVICE: { fetch(input: string, init: RequestInit): Promise<Response> };
  POOL_APP_SIGNING_KEY: string;
}) {
  return toolsRouteResolver(env.TOOLS_SERVICE, env.POOL_APP_SIGNING_KEY);
}
