import {
  forcedStopGraceMs,
  leakedStreamsMs,
  restartStartBoundMs,
} from "../runtime-slots/forced-restart-timing.ts";

/**
 * Why a row left its phase at its bound. Each one moves the row to quarantined, which takes no call
 * and holds its physical place until the provider proves the instance gone: no bound ever releases
 * a place on time alone.
 */
export type PhaseBound = "start_unproven" | "drain_unproven" | "absence_unproven";

/** A start answers within the container's startup allowance plus its activation, as a restart's does. */
export const startingBoundMs = restartStartBoundMs;
/** A drain whose count stays unknown or unreadable this long is unproven: the root's leaked-streams bound. */
export const drainingBoundMs = leakedStreamsMs;
/** A retirement that passed its drain stops within the forced-stop grace and one 15 s absence probe. */
export const retiringBoundMs = forcedStopGraceMs + 30_000;
/**
 * A ledger count lowered to its cell's own count must have stood still this long. The cell's count
 * decides, and it holds every live stream whatever its length, held model sockets included; the wait
 * only covers a call the ledger admitted before its cell counted it (admission gives up after 30 s)
 * and a release still on its way.
 */
export const countStillMs = leakedStreamsMs;
/** A held place has no time exit, so it says so again on this cadence for as long as it stays. */
export const quarantineReportMs = 60 * 60_000;

interface PhaseRow {
  phase: string;
  phaseAt?: number | undefined;
}

/** A row stored before phase times existed counts from the write that stamps it, never from the past. */
export function inPhaseFor(row: PhaseRow, now: number) {
  return row.phaseAt === undefined ? 0 : Math.max(0, now - row.phaseAt);
}

export function pastBound(row: PhaseRow, now: number) {
  if (row.phaseAt === undefined) return false;
  const held = inPhaseFor(row, now);
  if (row.phase === "reserved" || row.phase === "warming" || row.phase === "uncertain")
    return held >= startingBoundMs;
  if (row.phase === "draining") return held >= drainingBoundMs;
  if (row.phase === "retiring") return held >= retiringBoundMs;
  return false;
}

/** The fleet alarm's cadence while any row still has work to do. */
export const upkeepCadenceMs = 2_000;
/** How long a cell's health read may take; one the fleet alarm starts is answered by then. */
export const cellHealthReadMs = 2_000;

interface WakeRow extends PhaseRow {
  active: number;
  lastUsedAt: number;
  drainAcknowledged?: boolean | undefined;
}

/**
 * When the fleet alarm must run next. In quiet time it is the only actor, so no row may pass a bound
 * by more than one cadence without a pass.
 */
export function fleetWakeUp(
  rows: readonly WakeRow[],
  policy: { enabled: boolean; idleMilliseconds: number },
  now: number,
) {
  const cadence = now + upkeepCadenceMs;
  const deadlines = rows.map((row) => {
    if (row.phase === "ready") {
      const idleAt = row.lastUsedAt + (policy.enabled ? policy.idleMilliseconds : 0);
      // A cell kept past its idle bound, as the last one serving, waits for the cadence again.
      return (policy.enabled && row.active) || idleAt <= now
        ? cadence
        : Math.min(cadence, Math.max(now + 100, idleAt));
    }
    // A held stream's release wakes the fleet itself; a lost one is read again once it stood still.
    if (row.phase === "draining" && row.active && row.drainAcknowledged)
      return Math.max(
        cadence,
        Math.min(row.lastUsedAt + countStillMs, (row.phaseAt ?? now) + drainingBoundMs),
      );
    return cadence;
  });
  return deadlines.length ? Math.min(...deadlines) : undefined;
}

/** One closed line when a row enters quarantine and once an hour while it holds its place. */
export function logQuarantine(
  event: "entered" | "held",
  row: { target: { slotId: string; homePeerOrdinal?: number | undefined }; reason?: string },
  ageMs: number,
) {
  console.warn("POOL_FLEET_QUARANTINE", {
    event,
    slot: row.target.slotId,
    ordinal: row.target.homePeerOrdinal ?? null,
    reason: row.reason ?? null,
    ageMs,
  });
}
