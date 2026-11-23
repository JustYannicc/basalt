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
