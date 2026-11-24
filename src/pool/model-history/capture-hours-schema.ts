export const historyCaptureHoursVersion = "model_request_history_v17_capture_hours";

/**
 * Advisory lock class for one pool's capture-hour counts; unused by any other lock in this
 * database (the migrations take 1409, the usage rollups 1415).
 */
export const captureHoursLockClass = 1416;

/**
 * Additive only: one table the pool's own tick fills with the number of Home usage rows each of a
 * pool's hours holds, how many of them had no request when it counted, and when it counted them.
 * No trigger, and nothing on Home's tables: a count is a read of Home's usage, stored here, which
 * the summary compares with the hour's captured requests instead of probing every usage row of its
 * window. The count is today's population, which can shrink (a key rebound, a person deleted), so
 * an equal count alone never proves an hour: its rows' own probe must have found none missing.
 */
export const historyCaptureHoursStatements = [
  `CREATE TABLE basalt_model_capture_hours (
    pool varchar(16) NOT NULL, hour timestamptz NOT NULL, usage_requests integer NOT NULL,
    uncaptured_requests integer NOT NULL, checked_at timestamptz NOT NULL,
    PRIMARY KEY (pool, hour))`,
  // The recount reads the counts taken longest ago in one ordered read of this index.
  `CREATE INDEX basalt_model_capture_hours_checked ON basalt_model_capture_hours (checked_at)`,
];

/**
 * The hour before which a count can be settled: two hours behind the database's own clock, so
 * usage that lands late in an hour is in its count. Computed by the database, never the Worker.
 */
export const captureSettleHorizon =
  "date_trunc('hour',transaction_timestamp() - interval '2 hours','UTC')";

/** A stored count of an hour that was taken once the hour settled; an earlier one is uncounted. */
export const captureSettledAfter = (row: string) =>
  `${row}.checked_at >= ${row}.hour + interval '2 hours'`;

/**
 * How far back from the settle horizon the counts reach: 400 days. An hour older than that is
 * never complete to the summary and its stored count is pruned, so the recount's work stays bounded.
 */
export const captureHoursLookbackHours = 400 * 24;

/** The first hour the counts cover, in SQL: the settle horizon less the lookback. */
export const captureLookbackStart = (lookback: string = String(captureHoursLookbackHours)) =>
  `(${captureSettleHorizon} - ${lookback}::int * interval '1 hour')`;
