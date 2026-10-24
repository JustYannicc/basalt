import { captureError } from "./sentry.ts";
import { sentryOtlpTarget, type SentryEnv } from "./sentry-target.ts";
import { pageTemplate } from "./privacy.ts";

export type TraceEnv = SentryEnv;

export interface TraceExecutionContext {
  waitUntil(work: Promise<unknown>): void;
}

type TraceHandler = (forwardedRequest: Request) => Promise<Response>;

interface ParentTrace {
  readonly traceId: string;
  readonly spanId: string;
  readonly flags: string;
}

const validTraceparent = /^00-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/i;
const methods = new Set(["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"]);
const timeoutMs = 3000;

function isTelemetryRoute(path: string): boolean {
  return path === "/__telemetry" || path.startsWith("/__telemetry/") ||
    path === "/feedback/v1" || path.startsWith("/feedback/v1/") ||
    path === "/api/telemetry" || path.startsWith("/api/telemetry/");
}

function randomHex(length: number): string {
  const bytes = crypto.getRandomValues(new Uint8Array(length));
  if (bytes.every((byte) => byte === 0)) bytes[length - 1] = 1;
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function parentTrace(request: Request): ParentTrace | undefined {
  const match = validTraceparent.exec(request.headers.get("traceparent") ?? "");
  if (!match || /^0+$/.test(match[1]!) || /^0+$/.test(match[2]!)) return undefined;
  return { traceId: match[1]!.toLowerCase(), spanId: match[2]!.toLowerCase(), flags: match[3]!.toLowerCase() };
}

function sanitizedRequest(request: Request, traceparent?: string): Request {
  const headers = new Headers(request.headers);
  if (traceparent) headers.set("traceparent", traceparent);
  else headers.delete("traceparent");
  headers.delete("baggage");
  headers.delete("tracestate");
  return new Request(request, { headers });
}

function traceRequestHeaders(request: Request): { request: Request; traceId: string; spanId: string; parentSpanId?: string; flags: string } {
  const parent = parentTrace(request);
  const traceId = parent?.traceId ?? randomHex(16);
  const spanId = randomHex(8);
  const flags = parent?.flags ?? "01";
  return {
    request: sanitizedRequest(request, `00-${traceId}-${spanId}-${flags}`),
    traceId,
    spanId,
    ...(parent ? { parentSpanId: parent.spanId } : {}),
    flags,
  };
}

function monotonicNow(): number {
  return typeof performance === "undefined" ? Date.now() : performance.now();
}

function schedule(context: TraceExecutionContext | undefined, work: Promise<unknown>): void {
  const safeWork = work.catch(() => undefined);
  if (!context) {
    void safeWork;
    return;
  }
  try {
    context.waitUntil(safeWork);
  } catch {
    void safeWork;
  }
}

function otlpAttribute(key: string, value: string | number) {
  return {
    key,
    value: typeof value === "string" ? { stringValue: value } : { intValue: String(value) },
  };
}

async function exportSpan(
  env: TraceEnv,
  span: {
    traceId: string;
    spanId: string;
    parentSpanId?: string;
    name: string;
    method: string;
    route: string;
    status: number;
    startUnixNano: bigint;
    endUnixNano: bigint;
  },
): Promise<void> {
  const target = sentryOtlpTarget(env);
  if (!target) return;
  const attributes = [
    otlpAttribute("http.request.method", span.method),
    otlpAttribute("http.route", span.route),
    otlpAttribute("http.response.status_code", span.status),
  ];
  const data = {
    resourceSpans: [{
      resource: {
        attributes: [otlpAttribute("service.name", "basalt")],
      },
      scopeSpans: [{
        scope: { name: "basalt.telemetry" },
        spans: [{
          traceId: span.traceId,
          spanId: span.spanId,
          ...(span.parentSpanId ? { parentSpanId: span.parentSpanId } : {}),
          name: span.name,
          kind: 2,
          startTimeUnixNano: span.startUnixNano.toString(),
          endTimeUnixNano: span.endUnixNano.toString(),
          attributes,
          ...(span.status >= 500 ? { status: { code: 2 } } : {}),
        }],
      }],
    }],
  };
  try {
    const response = await fetch(target.url, {
      method: "POST",
      headers: { "content-type": "application/json", "x-sentry-auth": target.authHeader },
      body: JSON.stringify(data),
      redirect: "manual",
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (response.status < 200 || response.status >= 300) {
      await response.body?.cancel().catch(() => undefined);
      return;
    }
    await response.body?.cancel().catch(() => undefined);
  } catch {
    // Telemetry delivery must never alter the operation's response.
  }
}

/**
 * Wrap a request, pass only validated W3C trace context to bindings, and defer OTLP export.
 * Labels contain fixed routes, common methods, response status, and timing only.
 */
export async function traceRequest(
  env: TraceEnv,
  request: Request,
  handler: TraceHandler,
  context?: TraceExecutionContext,
): Promise<Response> {
  const pathname = new URL(request.url).pathname;
  // Reporting requests must not emit spans or errors back into their own telemetry destination.
  if (isTelemetryRoute(pathname)) {
    const parent = parentTrace(request);
    return handler(sanitizedRequest(request, parent && `00-${parent.traceId}-${parent.spanId}-${parent.flags}`));
  }
  const route = pageTemplate(pathname);
  const method = methods.has(request.method) ? request.method : "OTHER";
  const parent = traceRequestHeaders(request);
  const startUnixNano = BigInt(Date.now()) * 1_000_000n;
  const start = monotonicNow();
  let status = 500;
  let thrown: unknown;
  let didThrow = false;
  let response: Response | undefined;
  try {
    response = await handler(parent.request);
    status = response.status;
  } catch (error) {
    thrown = error;
    didThrow = true;
    schedule(context, captureError(env, "router_failure", route));
  }
  const elapsed = Math.max(0, monotonicNow() - start);
  const endUnixNano = startUnixNano + BigInt(Math.round(elapsed * 1_000_000));
  if (status >= 500 && !didThrow) schedule(context, captureError(env, `http_${status}`, route));
  if ((Number.parseInt(parent.flags, 16) & 1) !== 0) {
    schedule(context, exportSpan(env, {
      traceId: parent.traceId,
      spanId: parent.spanId,
      ...(parent.parentSpanId ? { parentSpanId: parent.parentSpanId } : {}),
      name: `${method} ${route}`,
      method,
      route,
      status,
      startUnixNano,
      endUnixNano,
    }));
  }
  if (didThrow) throw thrown;
  return response!;
}
