/** Private host acknowledgements and the local scheduler's signed policy. */
export const membershipPath = "/pool/v1/membership";
export const membershipPrefix = "sbm1";
export const membershipReadPath = "/api/internal/pool-membership";
export const membershipReadPrefix = "sbq1";
export const policyPrefix = "sbm-policy1";
export const policyUsePrefix = "sbm-use1";
export const policyHeader = "X-Signalbox-Native-Policy";
export const membershipRefreshMs = 5_000;
// The host reserves a pool before any link, account, app or audience change commits, and that
// reservation is read at once. Between changes this slower host read only catches state that changed
// another way; each five-second pass in between renews the last read's lease without host or Home calls.
export const membershipReadMs = 60_000;
// Leave clock-skew headroom below the native 15-second cap. Five-second upkeep
// and two-second installs renew with three seconds left after completion rearm.
export const membershipTtlMs = 12_000;
// The native scheduler refuses use assertions with more than two hours left on
// its own clock. Clock-skew headroom below that native 2-hour cap keeps a pool
// clock running behind the signer from refusing every fresh assertion.
export const modelUseAssertionTtlMs = 2 * 60 * 60_000 - 5 * 60_000;
// Every turn on a held Responses socket reuses its upgrade assertion. Renew the socket between
// turns this long before that assertion expires, leaving room for a pool clock running ahead.
export const modelSocketRenewalLeadMs = 5 * 60_000;
export const modelSocketRenewalReason = "Renewing model authority";
export const membershipGraceMs = 24 * 60 * 60_000;

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
