/** Private host acknowledgements and the local scheduler's signed policy. */
export const membershipPath = "/pool/v1/membership";
export const membershipPrefix = "sbm1";
export const membershipReadPath = "/api/internal/pool-membership";
export const membershipReadPrefix = "sbq1";
export const policyPrefix = "sbm-policy1";
export const policyUsePrefix = "sbm-use1";
export const policyHeader = "X-Signalbox-Native-Policy";
export const membershipRefreshMs = 5_000;
export const membershipTtlMs = 15_000;

export interface NativeMembershipAccount {
  account: string;
  requirement: string;
  provider: string;
  method: string;
  generation: number;
  driver: string | null;
  driverRevision: string | null;
  bindingRevision: string | null;
  homeReference: string | null;
}
export interface NativeMembershipSnapshot {
  pool: string;
  organization: string;
  native: boolean;
  accounts: readonly NativeMembershipAccount[];
}
export interface NativeMembershipPolicy {
  pool: string;
  organization: string;
  revision: number;
  expiresAt: number;
  accounts: readonly string[];
  dirty: boolean;
}
