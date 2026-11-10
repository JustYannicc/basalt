import { DriveError } from "./shared/index.ts";

export interface QuotaLimits {
  currentBytes: number;
  files: number;
  retainedBytes: number;
  classA: number;
  classB: number;
  readBytes: number;
}

export const defaultLimits: QuotaLimits = {
  currentBytes: 20_000_000_000,
  files: 100_000,
  retainedBytes: 21_000_000_000,
  // A guardrail against runaway writes, not a throttle: a heavy Obsidian day must fit.
  classA: 100_000,
  classB: 1_000_000,
  readBytes: 50_000_000_000,
};

export class QuotaExceeded extends DriveError {
  readonly resource: string;
  readonly used: number;
  readonly limit: number;
  readonly resetAt: string | null;
  constructor(resource: string, used: number, limit: number, resetAt: string | null = null) {
    super(
      "capacity",
      `Cloud quota ${resource}: ${used} used, limit ${limit}${resetAt ? `; resets ${resetAt}` : "; increase the allowance to save more"}. Saved files and history are retained.`,
    );
    this.resource = resource;
    this.used = used;
    this.limit = limit;
    this.resetAt = resetAt;
  }
}

export function effectiveLimits(overrides: Partial<QuotaLimits> = {}) {
  const limits = { ...defaultLimits, ...overrides };
  if (Object.values(limits).some((value) => !Number.isSafeInteger(value) || value < 0))
    throw new DriveError("invalid", "Quota limits must be non-negative safe integers");
  return limits;
}
