import { PoolStartupDeadline } from "../lifecycle.ts";

import { homeCodes, type RemovalDiagnostic } from "./diagnostic.ts";
export {
  homeCodes,
  removalCodes,
  removalDiagnostic,
  removalPhases,
  type RemovalDiagnostic,
} from "./diagnostic.ts";

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
