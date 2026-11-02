const categories = ["config", "auth", "decode", "sql", "encryption", "unknown"] as const;
const phases = [
  "config",
  "auth",
  "decode",
  "sql",
  "encryption",
  "forward",
  "request",
  "receipt",
] as const;
const sqlClasses = [
  "08",
  "09",
  "0A",
  "0B",
  "0F",
  "0L",
  "0P",
  "0Z",
  "20",
  "21",
  "22",
  "23",
  "24",
  "25",
  "26",
  "27",
  "28",
  "2B",
  "2D",
  "2F",
  "34",
  "38",
  "39",
  "3B",
  "3D",
  "3F",
  "40",
  "42",
  "44",
  "53",
  "54",
  "55",
  "57",
  "58",
  "72",
  "F0",
  "HV",
  "P0",
  "XX",
] as const;

export interface FailureReceipt {
  readonly format: "basalt-production-ops-failure-v1";
  readonly category: (typeof categories)[number];
  readonly phase: (typeof phases)[number];
  readonly sqlStateClass?: (typeof sqlClasses)[number];
  readonly httpStatus?: number;
}

export class OperationFailure extends Error {
  readonly receipt: FailureReceipt;
  constructor(receipt: FailureReceipt) {
    super("Production operation failed");
    this.receipt = receipt;
  }
}

/** Copy known fields only; the HTTP response and thrown message may contain credentials. */
export function failureReceipt(value: unknown): FailureReceipt | undefined {
  if (typeof value !== "object" || value === null) return;
  const row = value as Record<string, unknown>;
  const category = categories.find((entry) => entry === row.category);
  const phase = phases.find((entry) => entry === row.phase);
  if (row.format !== "basalt-production-ops-failure-v1" || !category || !phase) return;
  const sqlStateClass = sqlClasses.find((entry) => entry === row.sqlStateClass);
  return {
    format: "basalt-production-ops-failure-v1",
    category,
    phase,
    ...(category === "sql" && sqlStateClass ? { sqlStateClass } : {}),
  };
}

export const failure = (
  category: FailureReceipt["category"],
  phase: FailureReceipt["phase"],
  httpStatus?: number,
): FailureReceipt => ({
  format: "basalt-production-ops-failure-v1",
  category,
  phase,
  ...(httpStatus === undefined ? {} : { httpStatus }),
});
