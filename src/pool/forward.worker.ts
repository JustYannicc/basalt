import type { Computers } from "./computers.ts";
import { ControlFailure, failureResponse } from "./json.ts";
import {
  isPublicModelPath,
  PoolRuntimeUnhealthy,
  PoolStartupDeadline,
  type PoolLifecycle,
} from "./lifecycle.ts";
import { modelPaths, rewriteCapResponse } from "./cap-message.ts";
import { containerRequest } from "./container-request.ts";
import { nativeModelHeader } from "./native-contract.ts";
import { nativeResponse } from "./native-response.worker.ts";
import {
  gatewayUnavailable,
  gatewayOutcomeUnknown,
  type RefusalIdentity,
  type GatewayFailureDiagnostic,
} from "./gateway-failure.ts";
import { ModelMembershipUnavailable, modelMembership } from "./model-membership.ts";
import type { NativeMemberships } from "./membership.ts";
import type { NativeStreams } from "./native-streams.ts";
import { ProtectionRefusal, type RuntimeProtection } from "./runtime-protection.ts";

interface Dependencies {
  appModel?: import("./model-membership.ts").ModelIdentity;
  env: Parameters<typeof gatewayUnavailable>[0] & { POOL_APP_SIGNING_KEY: string };
  computers: Pick<Computers, "nativeModel" | "observeUsage">;
  memberships: NativeMemberships;
  streams: NativeStreams;
  lifecycle: Promise<PoolLifecycle>;
  route?: (
    request: Request,
    port: 8317 | 8327,
    pool: string | undefined,
    legacy: (request: Request, prepared: () => void) => Promise<Response>,
    beforeDispatch: () => void,
  ) => Promise<Response>;
  warm?: (
    legacy: () => Promise<import("./lifecycle.ts").PoolStatus>,
  ) => Promise<import("./lifecycle.ts").PoolStatus>;
  protection: RuntimeProtection;
  fetch(request: Request, port: 8317 | 8327): Promise<Response>;
  defer(work: Promise<unknown>): void;
}

/** Admission, forwarding and stream lifetime share one refusal path. */
export async function forwardPoolRequest(
  request: Request,
  port: 8317 | 8327 | undefined,
  deps: Dependencies,
): Promise<Response> {
  const pathname = new URL(request.url).pathname;
  let native: Awaited<ReturnType<Computers["nativeModel"]>> | undefined;
  let identity: RefusalIdentity | undefined;
  let modelLease: ReturnType<NativeStreams["acquire"]> | undefined;
  const started = performance.now();
  let dispatched = false;
  let guard: GatewayFailureDiagnostic["guard"] = "native_identity";
  try {
    if (request.headers.has(nativeModelHeader)) {
      native = await deps.computers.nativeModel(request);
      request = native.request;
    }
    if (isPublicModelPath(pathname)) {
      guard = "model_membership";
      const gate = await modelMembership(
        request,
        deps.memberships,
        deps.env.POOL_APP_SIGNING_KEY,
        deps.env.POOL_AUTH_DATABASE?.connectionString,
        deps.streams,
        native ?? deps.appModel,
      );
      request = gate.request;
      identity = gate.identity;
      modelLease = gate.lease;
    }
    guard = "runtime_readiness";
    const warm = () => deps.lifecycle.then((lifecycle) => lifecycle.warm());
    if (pathname === "/__warm") {
      await (deps.warm ? deps.warm(warm) : warm());
      return new Response(null, { status: 204 });
    }
    guard = "runtime_port";
    if (!port) throw new Error("Pool container port unavailable");
    let boot: string | undefined;
    const beforeDispatch = () => {
      guard = "upstream_dispatch";
      dispatched = true;
    };
    const legacy = async (forwarded: Request, prepared: () => void = () => {}) => {
      guard = "runtime_readiness";
      const status = await warm();
      boot = status.boot_id;
      if (modelLease) {
        guard = "runtime_protection";
        deps.protection.admit(status);
      }
      guard = "request_active";
      forwarded.signal.throwIfAborted();
      prepared();
      beforeDispatch();
      return deps.fetch(forwarded, port);
    };
    const outbound = containerRequest(request, "http://pool");
    const upstream = deps.route
      ? await deps.route(outbound, port, identity?.pool, legacy, beforeDispatch)
      : await legacy(outbound);
    guard = "upstream_response";
    const response = await rewriteCapResponse(upstream, pathname);
    if (
      request.method === "POST" &&
      (modelPaths.has(pathname) ||
        pathname === "/v1/systemone" ||
        pathname === "/typesafe/v1/systemone") &&
      response.ok
    )
      deps.defer(deps.computers.observeUsage());
    if (response.status === 101) {
      const forwarded = native === undefined ? response : nativeResponse(response, native);
      return modelLease === undefined ? forwarded : nativeResponse(forwarded, modelLease);
    }
    const headers = new Headers(response.headers);
    const observedBoot = upstream.headers.get("X-Signalbox-Pool-Boot") ?? boot;
    if (observedBoot) headers.set("X-Signalbox-Pool-Boot", observedBoot);
    const forwarded = new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
    const delivered = native === undefined ? forwarded : nativeResponse(forwarded, native);
    return modelLease === undefined ? delivered : nativeResponse(delivered, modelLease);
  } catch (error) {
    native?.release();
    modelLease?.release();
    const diagnostic: GatewayFailureDiagnostic = {
      guard,
      refusalReason: error instanceof ProtectionRefusal ? error.reason : guard,
      cause:
        error instanceof ModelMembershipUnavailable
          ? "ModelMembershipUnavailable"
          : error instanceof PoolRuntimeUnhealthy
            ? "PoolRuntimeUnhealthy"
            : error instanceof PoolStartupDeadline
              ? "PoolStartupDeadline"
              : error instanceof DOMException && error.name === "TimeoutError"
                ? "TimeoutError"
                : error instanceof DOMException && error.name === "AbortError"
                  ? "AbortError"
                  : error instanceof Error
                    ? "Error"
                    : "unknown",
    };
    if (dispatched && isPublicModelPath(pathname))
      return gatewayOutcomeUnknown(deps.env, request, (work) => deps.defer(work), diagnostic);
    if (error instanceof ModelMembershipUnavailable) identity = error.identity;
    if (error instanceof ControlFailure) return failureResponse(error);
    if (error instanceof PoolRuntimeUnhealthy || isPublicModelPath(pathname))
      return gatewayUnavailable(
        deps.env,
        request,
        identity,
        started,
        (work) => deps.defer(work),
        diagnostic,
      );
    // Startup and port errors are fixed runtime messages without request data or credentials.
    console.error(
      "Pool backend unavailable",
      error instanceof Error ? error.message.slice(0, 300) : "unknown error",
    );
    return new Response(null, {
      status: 503,
      headers: { "Retry-After": "5", "Cache-Control": "no-store" },
    });
  }
}
