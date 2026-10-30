type Operation = "membership" | "credentials" | "quota_detail" | "readiness";
interface ReadingTiming {
  operation: Operation;
  durationMs: number;
  count: number;
  failures: number;
}

/** Fixed operation names and numbers only. Home responses and selectors never enter logs. */
export async function timePoolRead<T>(
  operation: Operation,
  read: () => Promise<T>,
  count: (value: T) => number = () => 1,
  report: (timing: ReadingTiming) => void = (timing) => console.log("pool_home_read", timing),
  clock: () => number = () => performance.now(),
): Promise<T> {
  const started = clock();
  let total = 0, failures = 1;
  try {
    const value = await read();
    total = count(value);
    failures = 0;
    return value;
  } finally {
    try { report({ operation, durationMs: Math.max(0, Math.round(clock() - started)), count: total, failures }); }
    catch { /* Logging must not change the read's result. */ }
  }
}
