// Successful hosted verification times from Check 41709146925, attempt 1.
export const measuredSeconds = {
  "account-acquisition": 450,
  "compiler-diagnostics": 163,
  "contributed-accounts": 419,
  "host-managed-accounts": 671,
  "oauth-account-regressions": 242,
  "pool-account-recovery": 201,
  "production-ops": 506,
  "production-ops-migrations": 264,
  "production-ops-identity-physical": 127,
  "production-ops-identity-credentials": 168,
  "production-ops-identity-diagnostics": 110,
  "production-ops-identity-without-server": 164,
  "production-ops-identity-release": 195,
  "production-ops-identity-host": 170,
  "production-ops-identity-database": 195,
  "production-ops-identity-role": 171,
};

export const isEligibleJob = (id: string) =>
  Object.hasOwn(measuredSeconds, id) || id === "production-ops-identity";
