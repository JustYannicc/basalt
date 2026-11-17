import { setImmediate as yieldTurn } from "node:timers/promises";

/**
 * Production opens a fresh remote bridge to the controller for every runtime command, and that
 * setup alone takes seconds from a CI runner (a finalize health lease once expired on it). Every
 * fake bridge pays at least this much before it can dispatch.
 */
export const bridgeSetupMs = 2_000;

let offset = 0;
let installed = false;

/**
 * Moves every clock the release reads (Date.now and performance.now) forward without waiting, so a
 * deadline measured from those clocks sees the full latency while a release with dozens of serial
 * commands stays fast. A timer armed before the latency (setTimeout, AbortSignal.timeout) does not
 * fire early; the release's leases are clock comparisons, not timers.
 */
export async function elapse(ms: number) {
  if (ms <= 0) return;
  if (!installed) {
    installed = true;
    const now = Date.now.bind(Date);
    const monotonic = performance.now.bind(performance);
    // Never restored: once a process has seen time pass, no later reading may go back.
    Date.now = () => now() + offset;
    performance.now = () => monotonic() + offset;
  }
  offset += ms;
  await yieldTurn();
}
