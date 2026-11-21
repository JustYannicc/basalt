/** The production database a release backs up before apply: one branch, both logical databases. */
export const DATABASE_SCOPE = {
  provider: "planetscale-postgres-branch",
  database: "basalt",
  logicalDatabases: ["postgres", "basalt_pool"],
} as const;

export class SafetyGateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SafetyGateError";
  }
}
