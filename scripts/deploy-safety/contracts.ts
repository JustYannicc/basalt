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

/** JSON with object keys sorted, so equal values have one byte form for digests. */
export function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}
