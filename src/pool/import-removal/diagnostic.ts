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
