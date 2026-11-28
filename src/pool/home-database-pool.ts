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
 * Keeps the last counters Home reported, read once a minute, so refusal lines carry them without a
 * read on the refusal path. Home's `/capabilities` also runs one indexed `LIMIT 1` query, so a read
 * queues behind a saturated pool: it is bounded, and a late read leaves the last value and its age.
 */
export class HomeDatabasePoolMonitor {
  private read: (signal: AbortSignal) => Promise<unknown>;
  private now: () => number;
  private latest?: { pool: HomeDatabasePool; at: number };
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

  /** One read at a time, always settled within its bound even if the read ignores the signal. */
  private refresh(): Promise<void> {
    if (this.pending) return this.pending;
    const signal = AbortSignal.timeout(readMs);
    const late = new Promise<never>((_resolve, reject) =>
      signal.addEventListener("abort", () => reject(signal.reason), { once: true }),
    );
    const work = Promise.race([Promise.resolve().then(() => this.read(signal)), late])
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

  /**
   * Once per report interval, read Home and hand the result to the upkeep record. `timed` wraps only
   * a read that is due, so a pass that reads nothing writes nothing.
   */
  async report(
    record: (observation: HomeDatabasePoolObservation | null) => void,
    timed: (read: () => Promise<void>) => Promise<void> = (read) => read(),
  ) {
    if (this.now() - this.reportedAt < homeDatabasePoolReportMs) return;
    this.reportedAt = this.now();
    await timed(async () => {
      await this.refresh();
      record(this.observation());
    });
  }
}
