export const accountAcquisitionPath = "/pool/v1/account-acquisitions";
export const accountAcquisitionPrefix = "sbaa1";

export const acquisitionPhases = [
  "request",
  "state",
  "credentials",
  "attribution",
  "oauth_start",
  "oauth_status",
  "oauth_callback",
  "oauth_cancel",
  "cleanup",
] as const;
export const acquisitionErrorClasses = [
  "runtime_unhealthy",
  "transport",
  "timeout",
  "home_unavailable",
  "home_rejected",
  "invalid_response",
  "internal",
] as const;
export interface AcquisitionReceipt {
  phase: (typeof acquisitionPhases)[number];
  errorClass: (typeof acquisitionErrorClasses)[number];
  retryable: boolean;
}
