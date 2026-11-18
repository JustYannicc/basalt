/** Home's process-local database/sql counters from `server_info.database_pool` (carry 0284). */
export interface HomeDatabasePool {
  inUse: number;
  waitCount: number;
  waitDurationNs: number;
}
export interface HomeDatabasePoolObservation extends HomeDatabasePool {
  ageMs: number;
}

export const homeDatabasePoolReportMs = 60_000;
const refreshMs = 5_000;
const readMs = 2_000;

const field = (value: unknown, key: string): unknown =>
  value !== null && typeof value === "object" ? Reflect.get(value, key) : undefined;
const counter = (value: unknown) =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.round(value) : undefined;

export function homeDatabasePool(capabilities: unknown): HomeDatabasePool | undefined {
  const pool = field(field(capabilities, "server_info"), "database_pool");
  const inUse = counter(field(pool, "in_use"));
  const waitCount = counter(field(pool, "wait_count"));
  const waitDurationNs = counter(field(pool, "wait_duration_ns"));
  return inUse === undefined || waitCount === undefined || waitDurationNs === undefined
    ? undefined
    : { inUse, waitCount, waitDurationNs };
}

/**
 * Keeps the last counters Home reported, so refusal lines can carry them without a read on the
 * refusal path. Home answers from `database/sql` statistics, so a read never takes a connection.
 */
export class HomeDatabasePoolMonitor {
  private read: (signal: AbortSignal) => Promise<unknown>;
  private now: () => number;
  private latest?: { pool: HomeDatabasePool; at: number };
  private attemptedAt = Number.NEGATIVE_INFINITY;
  private reportedAt: number;
  private pending?: Promise<void>;
  constructor(read: (signal: AbortSignal) => Promise<unknown>, now: () => number = Date.now) {
    this.read = read;
    this.now = now;
    // The first record follows one full interval, so a fresh controller does not read Home at once.
    this.reportedAt = now();
  }

  observation(): HomeDatabasePoolObservation | null {
    return this.latest
      ? { ...this.latest.pool, ageMs: Math.max(0, this.now() - this.latest.at) }
      : null;
  }

  /** At most one read per interval; a refused, slow or malformed read keeps the previous value. */
  refresh(): Promise<void> {
    if (this.pending) return this.pending;
    if (this.now() - this.attemptedAt < refreshMs) return Promise.resolve();
    this.attemptedAt = this.now();
    const work = Promise.resolve()
      .then(() => this.read(AbortSignal.timeout(readMs)))
      .then((capabilities) => {
        const pool = homeDatabasePool(capabilities);
        if (pool) this.latest = { pool, at: this.now() };
      })
      .catch(() => {})
      .finally(() => {
        if (this.pending === work) this.pending = undefined;
      });
    this.pending = work;
    return work;
  }

  /** Once per report interval, refresh and hand the result to the upkeep record. */
  async report(record: (observation: HomeDatabasePoolObservation | null) => void) {
    if (this.now() - this.reportedAt < homeDatabasePoolReportMs) return;
    this.reportedAt = this.now();
    await this.refresh();
    record(this.observation());
  }
}
