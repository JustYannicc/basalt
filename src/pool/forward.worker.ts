import {
  refuseRuntime,
  runtimeRouteDiagnostic,
  runtimeResponseCause,
  runtimeResponseDiagnostic,
  stripRuntimeFailureHeaders,
} from "./runtime-route-diagnostic.ts";
import { isModelLifetimePath, stripModelLifetimeRequest } from "./model-lifetime-contract.ts";
import {
  reachedNoContainer,
  sentNowhere,
  unsentAnswer,
  unsentAttempt,
  unsentAttemptHeader,
} from "./controller-unsent.ts";
import { inheritModelLifetime, modelLifetimeFetch } from "./model-lifetime.worker.ts";
import { modelKeyScope } from "./key-scope.ts";
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
import { openRouterAttempt, routerAttemptHeader } from "./router-attempt.ts";
import { controllerIsolateHeader, isolate } from "./isolate.ts";
import { modelDrainProtocol } from "./model-drain-contract.ts";
import { nativeResponse } from "./native-response.worker.ts";
import {
  gatewayUnavailable,
  gatewayOutcomeUnknown,
  type RefusalIdentity,
  type GatewayFailureDiagnostic,
} from "./gateway-failure.ts";
import { ModelMembershipUnavailable, modelMembership } from "./model-membership.ts";
import { modelSocketRenewalLeadMs } from "./membership-contract.ts";
import type { NativeMemberships } from "./membership.ts";
import type { NativeStreams } from "./native-streams.ts";
import { ProtectionRefusal, type RuntimeProtection } from "./runtime-protection.ts";
import { dispatchTimingHeader, logDispatchTiming } from "./dispatch-timing.ts";
import { requestTerminal, type TerminalRecorder } from "./terminal-recording.worker.ts";
import { terminalResponse, type TerminalFinish } from "./terminal-response.worker.ts";
import { digest } from "./backend-users.ts";
import { endpointMetadata } from "./model-history/record.ts";
import { terminalSocket } from "./terminal-socket.worker.ts";
import {
  resumeLayerPort,
  resumeRoute,
  toLayer,
  streamResumableHeader,
  streamResumeEligibleHeader,
  streamResumeHeader,
  streamResumePoolHeader,
  streamResumeVersion,
} from "./stream-resume.ts";
import { captureRefusalModel } from "./refusal-model.ts";
import { endpointRequestId } from "./runtime-fleet/endpoint-trace.ts";
import type { HomeDatabasePoolMonitor } from "./home-database-pool.ts";

interface Dependencies {
  terminal?: TerminalRecorder;
  appModel?: import("./model-membership.ts").ModelIdentity;
  env: Parameters<typeof gatewayUnavailable>[0] & {
    POOL_APP_SIGNING_KEY: string;
    POOL_APP_SIGNING_KEY_PREVIOUS?: string;
  };
  computers: Pick<Computers, "nativeModel" | "observeUsage">;
  memberships: NativeMemberships;
  recoverAdmission?(signal: AbortSignal): Promise<boolean>;
  streams: NativeStreams;
  lifecycle: Promise<PoolLifecycle>;
  route?: (
    request: Request,
    port: 8317 | 8327,
    pool: string | undefined,
    legacy: (request: Request, prepared: () => void) => Promise<Response>,
    beforeDispatch: () => void,
    identity?: RefusalIdentity,
  ) => Promise<Response>;
  warm?: (
    legacy: () => Promise<import("./lifecycle.ts").PoolStatus>,
  ) => Promise<import("./lifecycle.ts").PoolStatus>;
  protection: RuntimeProtection;
  databasePool?: Pick<HomeDatabasePoolMonitor, "observation">;
  fetch(request: Request, port: 8317 | 8327 | typeof resumeLayerPort): Promise<Response>;
  /** Whether the container still runs; a stopped one's failure is never the front layer's. */
  running?(): boolean;
  defer(work: Promise<unknown>): void;
}

type AdmissionDependencies = Pick<
  Dependencies,
  "appModel" | "env" | "computers" | "memberships" | "recoverAdmission" | "streams"
>;

/**
 * Who may make this model call, and the leases it runs under: a device's own lease and its pool's.
 * A first call and a resume of one pass the same admission, so a caller no longer allowed is
 * refused either way, and a revocation or a pool's abort cuts a resumed part as it cuts a first
 * answer. It writes no record and counts no use. `call` is the call's request id.
 */
export async function admitModelCall(
  request: Request,
  deps: AdmissionDependencies,
  call: string,
  stage: (guard: "native_identity" | "model_membership") => void = () => {},
  /** Given the device's admission as soon as it holds; the caller then owns its release. */
  admittedDevice?: (native: Awaited<ReturnType<Computers["nativeModel"]>>) => void,
) {
  const pathname = new URL(request.url).pathname;
  let native: Awaited<ReturnType<Computers["nativeModel"]>> | undefined;
  stage("native_identity");
  if (request.headers.has(nativeModelHeader)) {
    native = await deps.computers.nativeModel(request, call);
    request = native.request;
    admittedDevice?.(native);
  } else if (request.headers.has("sec-websocket-protocol")) {
    const headers = new Headers(request.headers);
    const protocols = headers
      .get("sec-websocket-protocol")!
      .split(",")
      .map((value) => value.trim())
      .filter((value) => value !== modelDrainProtocol);
    if (protocols.length) headers.set("sec-websocket-protocol", protocols.join(", "));
    else headers.delete("sec-websocket-protocol");
    request = new Request(request, { headers });
  }
  if (!isPublicModelPath(pathname)) return { request, native };
  stage("model_membership");
  try {
    const gate = await modelMembership(
      request,
      deps.memberships,
      deps.env.POOL_APP_SIGNING_KEY,
      deps.env.POOL_AUTH_DATABASE?.connectionString,
      deps.streams,
      native ?? deps.appModel,
      deps.recoverAdmission,
      call,
    );
    return {
      request: gate.request,
      native,
      identity: gate.identity,
      modelLease: gate.lease,
      assertionExpiresAt: gate.assertionExpiresAt,
    };
  } catch (error) {
    if (!admittedDevice) native?.release();
    throw error;
  }
}

/** Admission, forwarding and stream lifetime share one refusal path. */
export async function forwardPoolRequest(
  request: Request,
  port: 8317 | 8327 | undefined,
  deps: Dependencies,
): Promise<Response> {
  const pathname = new URL(request.url).pathname;
  if (isModelLifetimePath(pathname)) return new Response(null, { status: 404 });
  request = stripModelLifetimeRequest(request);
  // A re-send of a call never sent keeps that attempt's id, so both count as one request. The
  // router names every send of one call alike, so its re-send after a lost pool does the same.
  const resent = unsentAttempt(request.headers.get(unsentAttemptHeader));
  const routed = await openRouterAttempt(
    request,
    deps.env.POOL_APP_SIGNING_KEY,
    deps.env.POOL_APP_SIGNING_KEY_PREVIOUS,
  );
  if (routed && routed.attempt > 1)
    console.info("POOL_ROUTER_REPLAY_RECEIVED", {
      requestId: routed.requestId,
      attempt: routed.attempt,
    });
  const requestId = resent ?? routed?.requestId ?? crypto.randomUUID();
  const endpoint = endpointMetadata(pathname);
  const modelCall =
    (request.method === "POST" &&
      (modelPaths.has(pathname) ||
        (endpoint.endpoint !== null && endpoint.apiType !== "video-retrieve") ||
        pathname === "/v1/systemone" ||
        pathname === "/typesafe/v1/systemone")) ||
    (request.method === "GET" && endpoint.apiType === "video-retrieve");
  const socketCall =
    request.method === "GET" &&
    pathname === "/v1/responses" &&
    request.headers.get("Upgrade")?.toLowerCase() === "websocket";
  const observing = !!deps.terminal || deps.env.POOL_MODEL_HISTORY_ENABLED === "true";
  const refusalModel =
    deps.env.POOL_MODEL_HISTORY_ENABLED === "true" && (modelCall || socketCall)
      ? captureRefusalModel(request)
      : undefined;
  let terminal: TerminalFinish | undefined;
  let native: Awaited<ReturnType<Computers["nativeModel"]>> | undefined;
  let identity: RefusalIdentity | undefined;
  let modelLease: ReturnType<NativeStreams["acquire"]> | undefined;
  let assertionExpiresAt: number | undefined;
  const started = performance.now();
  const resolveIdentity = async () => {
    if (identity) return identity;
    const known = native ?? deps.appModel;
    if (known) return { ...known, person: await digest(known.person) };
    const scope = await modelKeyScope(deps.env.POOL_AUTH_DATABASE?.connectionString, request);
    return scope?.pools.length === 1
      ? { pool: scope.pools[0]!, person: scope.person, keyId: scope.keyId }
      : undefined;
  };
  const observe = (id: string) =>
    requestTerminal(
      deps.env,
      id,
      pathname,
      resolveIdentity,
      (work) => deps.defer(work),
      deps.terminal,
    );
  let dispatched = false;
  let guard: GatewayFailureDiagnostic["guard"] = "native_identity";
  // Refusals carry Home's last pool counters; reading Home here would queue behind the same pool.
  const databasePool = () => deps.databasePool?.observation() ?? null;
  try {
    // The device's admission reaches this call at once, as before: a refusal after it is recorded
    // under the device's own key, and this call's catch releases it.
    const admitted = await admitModelCall(
      request,
      deps,
      requestId,
      (stage) => (guard = stage),
      (device) => {
        native = device;
        request = device.request;
      },
    );
    ({ request, native, identity, modelLease, assertionExpiresAt } = admitted);
    guard = "runtime_readiness";
    const warm = () => deps.lifecycle.then((lifecycle) => lifecycle.warm());
    if (pathname === "/__warm") {
      await (deps.warm ? deps.warm(warm) : warm());
      return new Response(null, { status: 204 });
    }
    guard = "runtime_port";
    if (!port) refuseRuntime("port_lookup", new Error("Pool container port unavailable"));
    let boot: string | undefined;
    const beforeDispatch = () => {
      refusalModel?.discard();
      guard = "upstream_dispatch";
      dispatched = true;
      if (modelCall && !terminal) terminal = observe(requestId);
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
      const dispatch = () => {
        prepared();
        beforeDispatch();
      };
      // The front layer keeps this call's answer only while this container advertises the layer.
      const routed = resumeRoute(forwarded, port, status);
      const sent = routed === "gone" ? forwarded : routed.request;
      const target = routed === "gone" ? port : routed.port;
      const send = (request: Request) =>
        target === resumeLayerPort
          ? toLayer(request, deps.fetch, deps.running)
          : deps.fetch(request, target);
      if (port === 8317 && (native !== undefined || modelLease !== undefined))
        return modelLifetimeFetch(sent, send, dispatch);
      dispatch();
      return send(sent);
    };
    const outboundHeaders = new Headers(request.headers);
    outboundHeaders.delete("X-Basalt-Request-Id");
    outboundHeaders.delete(unsentAttemptHeader);
    outboundHeaders.delete(routerAttemptHeader);
    if (modelCall || (socketCall && observing)) {
      outboundHeaders.set("X-Request-Id", requestId);
      outboundHeaders.set("X-Basalt-Request-Id", requestId);
    }
    // Only the hop that owns the container marks a call for its front layer; a caller never does.
    outboundHeaders.delete(streamResumableHeader);
    if (modelCall && !socketCall) outboundHeaders.set(streamResumeEligibleHeader, "1");
    else outboundHeaders.delete(streamResumeEligibleHeader);
    const outbound = containerRequest(
      new Request(request, { headers: outboundHeaders }),
      "http://pool",
    );
    const upstream = deps.route
      ? await deps.route(outbound, port, identity?.pool, legacy, beforeDispatch, identity)
      : await legacy(outbound);
    guard = "upstream_response";
    const runtimeRefusal = runtimeResponseDiagnostic(upstream);
    const runtimeCause = runtimeResponseCause(upstream);
    const runtimeRequestId = endpointRequestId(upstream) ?? requestId;
    if (runtimeRefusal)
      console.error("POOL_RUNTIME_ROUTE_FAILURE", {
        requestId: runtimeRequestId,
        // An unsent answer reaches its client under this call's own id, not the endpoint's trace.
        ...(sentNowhere(upstream) && runtimeRequestId !== requestId
          ? { attemptRequestId: requestId }
          : {}),
        code: "runtime-refused",
        status: upstream.status,
        ...runtimeRefusal,
        ...(runtimeCause ? { runtimeCause } : {}),
        homeDatabasePool: databasePool(),
      });
    logDispatchTiming(upstream.headers.get(dispatchTimingHeader));
    let response = await rewriteCapResponse(upstream, pathname);
    if (modelCall && request.method === "POST" && response.ok)
      deps.defer(
        (async () => {
          // Legacy pools have no membership identity. Resolve only after the reply, off admission's path.
          const keyId =
            identity?.keyId ??
            native?.keyId ??
            deps.appModel?.keyId ??
            (await modelKeyScope(deps.env.POOL_AUTH_DATABASE?.connectionString, request))?.keyId;
          if (keyId !== undefined) await deps.computers.observeUsage(keyId);
        })().catch(() => console.error("POOL_FIRST_REQUEST_OBSERVATION_PENDING")),
      );
    if (response.status === 101) {
      if (response.headers.has(dispatchTimingHeader)) {
        const headers = new Headers(response.headers);
        headers.delete(dispatchTimingHeader);
        response = inheritModelLifetime(
          response,
          new Response(null, { status: 101, headers, webSocket: response.webSocket }),
        );
      }
      // Renewal must survive observation being off: without it a held socket fails at expiry.
      const renewAt =
        socketCall && assertionExpiresAt !== undefined
          ? assertionExpiresAt - modelSocketRenewalLeadMs
          : undefined;
      const relayed =
        socketCall && (observing || renewAt !== undefined)
          ? inheritModelLifetime(
              response,
              terminalSocket(
                response,
                requestId,
                observing ? observe : () => undefined,
                response.headers.get("X-Basalt-Terminal-Protocol") === "1",
                renewAt,
              ),
            )
          : response;
      const forwarded = native === undefined ? relayed : nativeResponse(relayed, native);
      return modelLease === undefined ? forwarded : nativeResponse(forwarded, modelLease);
    }
    // A call its runtime refused before the send ran nowhere: no outcome now, since the entry's
    // re-send finishes this request under the same id.
    if (terminal && sentNowhere(response)) terminal = undefined;
    if (terminal && upstream.headers.get("X-Basalt-Request-Id") !== requestId) {
      terminal("unavailable", response.status, 0);
      terminal = undefined;
    }
    const headers = new Headers(response.headers);
    headers.delete("X-Basalt-Request-Id");
    headers.delete("X-Basalt-Terminal-Protocol");
    // Only this hop names the pool it admitted the call under, for that call's resume.
    headers.delete(streamResumePoolHeader);
    const admittedPool = identity?.pool ?? native?.pool;
    if (admittedPool && headers.get(streamResumeHeader) === streamResumeVersion)
      headers.set(streamResumePoolHeader, admittedPool);
    headers.delete(dispatchTimingHeader);
    stripRuntimeFailureHeaders(headers);
    // An unsent answer names this call's own id, the one its terminal start was written under,
    // so the entry's re-send can finish that same row.
    if (modelCall) headers.set(controllerIsolateHeader, isolate().id);
    if (modelCall || runtimeRefusal)
      headers.set(
        "X-Request-Id",
        runtimeRefusal && !sentNowhere(response) ? runtimeRequestId : requestId,
      );
    const observedBoot = upstream.headers.get("X-Signalbox-Pool-Boot") ?? boot;
    if (observedBoot) headers.set("X-Signalbox-Pool-Boot", observedBoot);
    const forwarded = new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
    // A caller the router named that left before this answer may be sent again under the same id,
    // when only the entry went down; that send's own outcome finishes the row.
    if (terminal && routed && request.signal.aborted) terminal = undefined;
    const observed = terminal
      ? terminalResponse(
          forwarded,
          terminal,
          request.signal,
          pathname,
          // A status poll delivers job state, including failure; it does not execute the job again.
          request.method === "GET" && endpoint.apiType === "video-retrieve" ? "delivery" : "model",
        )
      : forwarded;
    const delivered = native === undefined ? observed : nativeResponse(observed, native);
    return modelLease === undefined ? delivered : nativeResponse(delivered, modelLease);
  } catch (error) {
    native?.release();
    modelLease?.release();
    const diagnostic: GatewayFailureDiagnostic = {
      ...runtimeRouteDiagnostic(error),
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
      homeDatabasePool: databasePool(),
    };
    // The runtime's endpoint refused before its container send: nothing ran, so the entry may send
    // the call it holds once more instead of reporting an unknown outcome.
    if (
      dispatched &&
      isPublicModelPath(pathname) &&
      !request.signal.aborted &&
      reachedNoContainer(error)
    )
      return unsentAnswer(request, requestId, diagnostic);
    if (dispatched && isPublicModelPath(pathname)) {
      if (!(routed && request.signal.aborted))
        terminal?.("unavailable", request.signal.aborted ? 499 : 502, 0);
      return gatewayOutcomeUnknown(
        deps.env,
        request,
        (work) => deps.defer(work),
        diagnostic,
        requestId,
      );
    }
    if (error instanceof ModelMembershipUnavailable) identity = error.identity;
    if (error instanceof ControlFailure) return failureResponse(error);
    // A re-send of a call never sent that is refused again before its own send ran nowhere either.
    // It stays the one request its first attempt started: no refusal record beside that start, even
    // when its client has left, and the entry keeps sending inside its window.
    if (resent && isPublicModelPath(pathname))
      return unsentAnswer(request, requestId, diagnostic, true);
    if (error instanceof PoolRuntimeUnhealthy || isPublicModelPath(pathname))
      return gatewayUnavailable(
        deps.env,
        request,
        identity,
        started,
        (work) => deps.defer(work),
        diagnostic,
        requestId,
        refusalModel?.read(),
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
  } finally {
    refusalModel?.discard();
  }
}
