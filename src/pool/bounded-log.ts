/**
 * At most this many lines of one name per isolate in a window; past it, lines are counted and the
 * next line written carries how many were left out. A replacement that cuts every call in flight
 * writes about one line per call, which stays far under this.
 */
export const boundedLogLimit = 200;
export const boundedLogWindowMs = 60_000;

const windows = new Map<string, { start: number; written: number; suppressed: number }>();

/**
 * Writes one closed line, inside its name's bound. It imports nothing, so the router can use it
 * without loading the pool's runtime.
 */
export function boundedLog(
  name: string,
  fields: Record<string, unknown>,
  write: (name: string, fields: Record<string, unknown>) => void = console.info,
  now = Date.now(),
) {
  let window = windows.get(name);
  if (!window || now - window.start >= boundedLogWindowMs) {
    window = { start: now, written: 0, suppressed: window?.suppressed ?? 0 };
    windows.set(name, window);
  }
  if (window.written >= boundedLogLimit) {
    window.suppressed++;
    return;
  }
  window.written++;
  const suppressed = window.suppressed;
  window.suppressed = 0;
  write(name, suppressed ? { ...fields, suppressed } : fields);
}
