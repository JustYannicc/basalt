import { PoolStartupDeadline } from "../lifecycle.ts";

export const removalPhases = [
  "readiness",
  "snapshot",
  "credential-delete",
  "membership-delete",
  "verify",
  "receipt",
] as const;
export const removalCodes = [
  "deadline_exceeded",
  "runtime_unavailable",
  "home_http",
  "home_transport",
  "snapshot_changed",
  "snapshot_unavailable",
  "receipt_changed",
  "retained_changed",
  "recovery_required",
  "verification_failed",
  "receipt_unavailable",
] as const;
export const homeCodes = [
  "auth_load_failed",
  "not_found",
  "write_failed",
  "reload_failed",
  "channel_group_detail_delete_failed",
  "invalid_request",
  "unauthorized",
  "forbidden",
  "precondition_failed",
] as const;
export interface RemovalDiagnostic {
  phase: (typeof removalPhases)[number];
  code: (typeof removalCodes)[number];
  elapsedMs: number;
  rowId?: string;
  homeStatus?: number;
  homeCode?: (typeof homeCodes)[number];
}

export function removalDiagnostic(value: Record<string, unknown>): RemovalDiagnostic | undefined {
  const phase = removalPhases.find((phase) => phase === value.phase);
  const code = removalCodes.find((code) => code === value.code);
  if (
    !phase ||
    !code ||
    typeof value.elapsedMs !== "number" ||
    !Number.isSafeInteger(value.elapsedMs) ||
    value.elapsedMs < 0 ||
    value.elapsedMs > 86_400_000
  )
    return;
  const rowId =
    typeof value.rowId === "string" &&
    /^(?:[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}|[1-9][0-9]{0,19})$/.test(
      value.rowId,
    )
      ? value.rowId
      : undefined;
  const homeStatus =
    typeof value.homeStatus === "number" &&
    Number.isInteger(value.homeStatus) &&
    value.homeStatus >= 100 &&
    value.homeStatus <= 599
      ? value.homeStatus
      : undefined;
  const homeCode = homeCodes.find((code) => code === value.homeCode);
  return {
    phase,
    code,
    elapsedMs: value.elapsedMs,
    ...(rowId === undefined ? {} : { rowId }),
    ...(homeStatus === undefined ? {} : { homeStatus }),
    ...(homeCode === undefined ? {} : { homeCode }),
  };
}

export class RemovalExecutionFailure extends Error {
  readonly diagnostic: RemovalDiagnostic;
  constructor(diagnostic: RemovalDiagnostic) {
    super("Home import removal failed");
    this.diagnostic = diagnostic;
  }
}

export function executionResponse(diagnostic: RemovalDiagnostic) {
  switch (diagnostic.code) {
    case "deadline_exceeded":
      return { status: 504, category: "timeout", error: "operation_failed" };
    case "home_http":
    case "home_transport":
    case "runtime_unavailable":
      return { status: 502, category: "home", error: "operation_failed" };
    case "snapshot_changed":
    case "receipt_changed":
    case "retained_changed":
    case "recovery_required":
      return { status: 409, category: "refused", error: "operation_refused" };
    default:
      return { status: 500, category: "unknown", error: "operation_failed" };
  }
}

export function executionFailure(
  error: unknown,
  phase: RemovalDiagnostic["phase"],
  startedAt: number,
  rowId?: string,
): RemovalExecutionFailure {
  if (error instanceof RemovalExecutionFailure) return error;
  const timeout =
    error instanceof PoolStartupDeadline ||
    (error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError"));
  return new RemovalExecutionFailure({
    phase,
    code: timeout
      ? "deadline_exceeded"
      : phase === "readiness"
        ? "runtime_unavailable"
        : phase === "receipt"
          ? "receipt_unavailable"
          : phase === "snapshot"
            ? "snapshot_unavailable"
            : phase === "verify"
              ? "verification_failed"
              : "home_transport",
    elapsedMs: Math.min(86_400_000, Math.max(0, Date.now() - startedAt)),
    ...(rowId === undefined ? {} : { rowId }),
  });
}

/** Home responses may contain credentials; only closed error codes cross this boundary. */
export async function homeFailure(
  response: Response,
  phase: RemovalDiagnostic["phase"],
  startedAt: number,
  rowId: string,
) {
  let homeCode: RemovalDiagnostic["homeCode"];
  const reader = response.body?.getReader();
  if (reader) {
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      for (;;) {
        const next = await reader.read();
        if (next.done) break;
        size += next.value.byteLength;
        if (size > 4096) break;
        chunks.push(next.value);
      }
      if (size <= 4096) {
        const value: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        if (value && typeof value === "object" && "error" in value)
          homeCode = homeCodes.find((code) => code === value.error);
      }
    } catch {
      /* The status remains useful when the body is unavailable. */
    } finally {
      await reader.cancel().catch(() => {});
      reader.releaseLock();
    }
  }
  return new RemovalExecutionFailure({
    phase,
    code: "home_http",
    elapsedMs: Math.min(86_400_000, Math.max(0, Date.now() - startedAt)),
    rowId,
    homeStatus: response.status,
    ...(homeCode === undefined ? {} : { homeCode }),
  });
}
