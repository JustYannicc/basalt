import type { Computers } from "./computers.ts";
import { ControlFailure, failureResponse } from "./json.ts";
import { isPublicModelPath, PoolRuntimeUnhealthy, type PoolLifecycle } from "./lifecycle.ts";
import { modelPaths, rewriteCapResponse } from "./cap-message.ts";
import { containerRequest } from "./container-request.ts";
import { nativeModelHeader } from "./native-contract.ts";
import { nativeResponse } from "./native-response.worker.ts";
import { gatewayUnavailable, gatewayOutcomeUnknown, type RefusalIdentity } from "./gateway-failure.ts";
import { ModelMembershipUnavailable, modelMembership } from "./model-membership.ts";
import type { NativeMemberships } from "./membership.ts";
import type { NativeStreams } from "./native-streams.ts";
import type { RuntimeProtection } from "./runtime-protection.ts";

interface Dependencies {
  env: Parameters<typeof gatewayUnavailable>[0] & { POOL_APP_SIGNING_KEY: string };
  computers: Pick<Computers, "nativeModel" | "observeUsage">;
  memberships: NativeMemberships;
  streams: NativeStreams;
  lifecycle: Promise<PoolLifecycle>;
  protection: RuntimeProtection;
  fetch(request: Request, port: 8317 | 8327): Promise<Response>;
  defer(work: Promise<unknown>): void;
}

/** Admission, forwarding and stream lifetime share one refusal path. */
export async function forwardPoolRequest(request: Request, port: 8317 | 8327 | undefined, deps: Dependencies): Promise<Response> {
  const pathname = new URL(request.url).pathname;
  let native: Awaited<ReturnType<Computers["nativeModel"]>> | undefined;
  let identity: RefusalIdentity | undefined;
  let modelLease: ReturnType<NativeStreams["acquire"]> | undefined;
  const started = performance.now();
  let dispatched = false;
  try {
    if (request.headers.has(nativeModelHeader)) {
      native = await deps.computers.nativeModel(request);
      request = native.request;
    }
    if (isPublicModelPath(pathname)) {
      const gate = await modelMembership(request, deps.memberships, deps.env.POOL_APP_SIGNING_KEY,
        deps.env.POOL_AUTH_DATABASE?.connectionString, native);
      request = gate.request;
      identity = gate.identity;
      if (gate.pool) {
        modelLease = deps.streams.acquire(crypto.randomUUID(), gate.pool, request.signal);
        request = new Request(request, { signal: modelLease.signal });
      }
    }
    const status = await (await deps.lifecycle).warm();
    if (pathname === "/__warm") return new Response(null, { status: 204 });
    if (modelLease) deps.protection.admit(status);
    request.signal.throwIfAborted();
    if (!port) throw new Error("Pool container port unavailable");
    dispatched = true;
    const upstream = await deps.fetch(containerRequest(request, "http://pool"), port);
    const response = await rewriteCapResponse(upstream, pathname);
    if (request.method === "POST" && (modelPaths.has(pathname) || pathname === "/v1/systemone" || pathname === "/typesafe/v1/systemone") && response.ok)
      deps.defer(deps.computers.observeUsage());
    if (response.status === 101) {
      const forwarded = native === undefined ? response : nativeResponse(response, native);
      return modelLease === undefined ? forwarded : nativeResponse(forwarded, modelLease);
    }
    const headers = new Headers(response.headers);
    headers.set("X-Signalbox-Pool-Boot", status.boot_id);
    const forwarded = new Response(response.body, { status: response.status, statusText: response.statusText, headers });
    const delivered = native === undefined ? forwarded : nativeResponse(forwarded, native);
    return modelLease === undefined ? delivered : nativeResponse(delivered, modelLease);
  } catch (error) {
    native?.release();
    modelLease?.release();
    if (dispatched && isPublicModelPath(pathname))
      return gatewayOutcomeUnknown(deps.env, request, (work) => deps.defer(work));
    if (error instanceof ModelMembershipUnavailable) identity = error.identity;
    if (error instanceof ControlFailure) return failureResponse(error);
    if (error instanceof PoolRuntimeUnhealthy || isPublicModelPath(pathname))
      return gatewayUnavailable(deps.env, request, identity, started, (work) => deps.defer(work));
    // Startup and port errors are fixed runtime messages without request data or credentials.
    console.error("Pool backend unavailable", error instanceof Error ? error.message.slice(0, 300) : "unknown error");
    return new Response(null, { status: 503, headers: { "Retry-After": "5", "Cache-Control": "no-store" } });
  }
}
