import type { ControlErrorCode } from "../../apps/pool/contract.ts";

export type Json = Record<string, unknown>;

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
}
export function fail(status: number, code: ControlErrorCode, message: string, retryAfterSeconds?: number): never {
  throw new ControlFailure(status, code, message, retryAfterSeconds);
}
const unavailableMessage = "The pool backend is unavailable. Try again later.";
export function unavailable(): never {
  return fail(503, "backend_unavailable", unavailableMessage);
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
  return { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(value) };
}

/** Backend status stays internal; callers receive the fixed unavailable message. */
export class BackendFailure extends ControlFailure {
  readonly backendStatus: number;
  constructor(status: number) {
    super(503, "backend_unavailable", unavailableMessage);
    this.backendStatus = status;
  }
}
export function failureResponse(error: unknown): Response {
  if (!(error instanceof ControlFailure)) return unavailableResponse();
  const response = json({ error: error.code, message: error.message }, error.status);
  if (error.retryAfterSeconds !== undefined) response.headers.set("Retry-After", String(error.retryAfterSeconds));
  return response;
}
