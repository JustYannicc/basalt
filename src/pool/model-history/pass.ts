import type { ReportingProgress } from "../reporting.ts";
import { captureHomeRequests } from "./capture.ts";
import { deliverPoolHistoryChanges, type PoolHistoryChange } from "./change-revisions.ts";
import type { HistoryDatabase } from "./schema.ts";

/** No forward page starts once a capture session has run this long; the session deadline is 20 s. */
export const captureSessionMs = 12_000;
/** A pass that is still behind after this many capture sessions leaves the rest to the next pass. */
export const captureSessionsPerPass = 2;

export interface ModelHistoryPass {
  /** One bounded database session. */
  session: <T>(work: (db: HistoryDatabase) => Promise<T>) => Promise<T>;
  publish: (changes: readonly PoolHistoryChange[]) => Promise<void>;
  /** Absent without a probe target. */
  reliability?: () => Promise<unknown>;
  rollup: () => Promise<unknown>;
  hours: () => Promise<unknown>;
  /** How far history is from Home, logged in counts (capture-gap.ts); absent where not wired. */
  gap?: () => Promise<unknown>;
  /** True once a code handover drains: no new page starts and no new session opens. */
  stopped: () => boolean;
  now?: () => number;
}

/**
 * Capture, then the reliability figure, then the rollup and capture-hours ticks, each only after a
 * capture that committed. `progress` carries where the pass's time and rows went, so a failure
 * still reports the part it finished.
 */
export async function runModelHistoryPass(pass: ModelHistoryPass, progress: ReportingProgress) {
  const now = pass.now ?? (() => performance.now());
  const split = {
    captureMs: 0,
    deliveryMs: 0,
    reliabilityMs: 0,
    rollupMs: 0,
    hoursMs: 0,
    pages: 0,
    newRows: 0,
    sweptRows: 0,
  };
  progress.split = split;
  progress.rows = 0;
  let caughtUp = false,
    sessions = 0;
  while (sessions < captureSessionsPerPass && !caughtUp && !pass.stopped()) {
    sessions++;
    const opened = now();
    await pass.session(async (db) => {
      // A session always gets its first page, however long the backfill and sweep took before it.
      const result = await captureHomeRequests(db, {
        stop: (pages) => pass.stopped() || (pages > 0 && now() - opened >= captureSessionMs),
      });
      split.captureMs += Math.round(now() - opened);
      if (result.state === "active") {
        progress.rows = (progress.rows ?? 0) + result.scanned;
        split.pages += result.pages;
        split.newRows += result.fresh;
        split.sweptRows += result.swept;
        caughtUp = result.caughtUp;
      } else caughtUp = true;
      const delivering = now();
      await deliverPoolHistoryChanges(db, result.pending, pass.publish);
      split.deliveryMs += Math.round(now() - delivering);
    });
  }
  // A handover that drained before any session leaves this pass incomplete, not behind.
  if (!caughtUp) progress.outcome = sessions ? "partial" : "incomplete";
  const timed = async (
    key: "reliabilityMs" | "rollupMs" | "hoursMs",
    work: () => Promise<unknown>,
  ) => {
    const started = now();
    await work();
    split[key] = Math.round(now() - started);
  };
  // Its own session, so a slow figure cannot fail a capture that already committed. A draining
  // handover skips it; both ticks below end at once on their own when stopped.
  if (pass.reliability && !pass.stopped())
    await timed("reliabilityMs", () =>
      pass.reliability!().catch(() => console.error("POOL_RELIABILITY_CAPTURE_PENDING")),
    );
  // The pool backfills its own usage rollup in bounded sessions, so nothing above waits behind it.
  await timed("rollupMs", () =>
    pass.rollup().catch(() => console.error("POOL_USAGE_ROLLUP_TICK_PENDING")),
  );
  // After the rollup's, in sessions of its own: the pool counts each settled hour's Home usage rows.
  await timed("hoursMs", () =>
    pass.hours().catch(() => console.error("POOL_CAPTURE_HOURS_TICK_PENDING")),
  );
  // Last, from the counts just taken; its failure costs only the line.
  if (pass.gap && !pass.stopped())
    await pass.gap().catch(() => console.error("POOL_MODEL_HISTORY_GAP_PENDING"));
}
