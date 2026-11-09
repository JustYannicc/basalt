import {
  isNativePolicyLeaseMs,
  isNativePolicyReason,
  type NativePolicyReason,
} from "./native-policy-diagnostic.ts";
import type { ControlError, ControlErrorCode } from "../../apps/pool/contract.ts";

export type Json = Record<string, unknown>;

export interface PoolFailureDiagnostic {
  guard: "membership_read" | "membership_body" | "reconciliation" | "native_policy_install";
  failure:
    | "response_status"
    | "invalid_body"
    | "transport"
    | "timeout"
    | "runtime_unhealthy"
    | "storage"
    | "unknown";
  backendStatus?: number;
  reason?: NativePolicyReason;
  leaseMs?: number;
}
const diagnostics = new WeakMap<object, PoolFailureDiagnostic>();
const diagnosticGuards = new Set<PoolFailureDiagnostic["guard"]>([
  "membership_read",
  "membership_body",
  "reconciliation",
  "native_policy_install",
]);
const diagnosticFailures = new Set<PoolFailureDiagnostic["failure"]>([
  "response_status",
  "invalid_body",
  "transport",
  "timeout",
  "runtime_unhealthy",
  "storage",
  "unknown",
]);

export function poolFailureDiagnostic(error: unknown): PoolFailureDiagnostic | undefined {
  return typeof error === "object" && error !== null ? diagnostics.get(error) : undefined;
}

/** Annotate the original error without changing how model and control callers handle it. */
export function diagnosePoolFailure(error: unknown, diagnostic: PoolFailureDiagnostic): unknown {
  const backendStatus = diagnostic.backendStatus;
  if (
    typeof error === "object" &&
    error !== null &&
    !diagnostics.has(error) &&
    diagnosticGuards.has(diagnostic.guard) &&
    diagnosticFailures.has(diagnostic.failure)
  )
    diagnostics.set(error, {
      guard: diagnostic.guard,
      failure: diagnostic.failure,
      ...(diagnostic.guard === "native_policy_install" && isNativePolicyReason(diagnostic.reason)
        ? { reason: diagnostic.reason }
        : {}),
      ...(diagnostic.guard === "native_policy_install" &&
      diagnostic.reason === "lease_window" &&
      isNativePolicyLeaseMs(diagnostic.leaseMs)
        ? { leaseMs: diagnostic.leaseMs }
        : {}),
      ...(typeof backendStatus === "number" &&
      Number.isInteger(backendStatus) &&
      backendStatus >= 100 &&
      backendStatus <= 599
        ? { backendStatus }
        : {}),
    });
  return error;
}

export class ControlFailure extends Error {
  readonly status: number;
  readonly code: ControlErrorCode;
  readonly retryAfterSeconds?: number;
  constructor(status: number, code: ControlErrorCode, message: string, retryAfterSeconds?: number) {
    super(message);
    this.status = status;
    this.code = code;
    this.retryAfterSeconds = retryAfterSeconds;
  }
  response(): ControlError {
    return { error: this.code, message: this.message };
  }
}
export function fail(
  status: number,
  code: ControlErrorCode,
  message: string,
  retryAfterSeconds?: number,
): never {
  throw new ControlFailure(status, code, message, retryAfterSeconds);
}
const unavailableMessage = "The pool backend is unavailable. Try again later.";
export function unavailable(diagnostic?: PoolFailureDiagnostic): never {
  const error = new ControlFailure(503, "backend_unavailable", unavailableMessage);
  if (diagnostic) diagnosePoolFailure(error, diagnostic);
  throw error;
}
export function json(value: unknown, status = 200): Response {
  return Response.json(value, { status, headers: { "Cache-Control": "no-store" } });
}
export function unavailableResponse(): Response {
  return json({ error: "backend_unavailable", message: unavailableMessage }, 503);
}
export function object(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
export function text(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}
export function rows(value: unknown): Json[] {
  if (!Array.isArray(value) || !value.every(object)) return unavailable();
  return value;
}
export function post(value: unknown): RequestInit {
  return {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(value),
  };
}

/** Backend status stays internal; callers receive the fixed unavailable message. */
export class BackendFailure extends ControlFailure {
  readonly backendStatus: number;
  constructor(status: number) {
    super(503, "backend_unavailable", unavailableMessage);
    this.backendStatus = status;
  }
}
export function reportPoolFailure(error: unknown): void {
  const diagnostic =
    typeof error === "object" && error !== null ? diagnostics.get(error) : undefined;
  if (diagnostic && (!(error instanceof ControlFailure) || error.status === 503)) {
    try {
      console.error("pool_guard_failure", diagnostic);
    } catch {
      /* Diagnostics must not change the refusal. */
    }
  }
}

export function failureResponse(error: unknown): Response {
  reportPoolFailure(error);
  if (!(error instanceof ControlFailure)) return unavailableResponse();
  const response = json(error.response(), error.status);
  if (error.retryAfterSeconds !== undefined)
    response.headers.set("Retry-After", String(error.retryAfterSeconds));
  return response;
}

export async function readBody(request: Request, limit: number): Promise<Uint8Array | undefined> {
  const reader = request.body?.getReader({ mode: "byob" });
  if (!reader) return new Uint8Array();
  let bytes = new Uint8Array(limit + 1);
  let size = 0;
  try {
    for (;;) {
      // A default reader can deliver an arbitrarily large pre-auth chunk before we reject it.
      const { value, done } = await reader.read(bytes.subarray(size));
      if (value === undefined) break;
      bytes = new Uint8Array(value.buffer);
      size += value.byteLength;
      if (size > limit) {
        void reader.cancel().catch(() => {});
        return undefined;
      }
      if (done) break;
    }
  } finally {
    reader.releaseLock();
  }
  return bytes.subarray(0, size);
}

/** The transport retains only a closed class, never the backend's exception or body. */
export class HomeTransportFailure extends ControlFailure {
  readonly errorClass: "runtime_unhealthy" | "transport" | "timeout";
  constructor(errorClass: "runtime_unhealthy" | "transport" | "timeout") {
    super(503, "backend_unavailable", "The pool backend is temporarily unavailable.");
    this.errorClass = errorClass;
  }
}
