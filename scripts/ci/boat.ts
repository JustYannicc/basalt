// One ordinary job per VM keeps the 16 GB runner free of competing suites.
// Twelve non-matrix jobs fit the $20 tier's included starts per minute.
export const boatJobs = [
  "host-managed-accounts",
  "host-managed-accounts-adopted",
  "host-managed-accounts-pool",
  "host-managed-accounts-local",
  "host-managed-accounts-cloud",
  "host-managed-accounts-cloud-actions",
  "production-ops",
  "account-acquisition",
  "compiler-diagnostics",
  "pool-runtime",
  "catalog-compat",
  "contributed-accounts",
];

export function configuredBoatJobs(value: string) {
  const configured =
    value === "proof"
      ? boatJobs
      : [
          ...new Set(
            value
              .toLowerCase()
              .split(",")
              .map((job) => job.trim())
              .filter(Boolean),
          ),
        ];
  if (configured.some((job) => !boatJobs.includes(job)))
    throw new Error("Unknown configured Boat job");
  return configured;
}
