import type { TestContext } from "node:test";

/** A cancelled test must retain its last observation before cleanup kills fixture processes. */
export function fixturePhases(t: TestContext, fixture: string) {
  const started = performance.now();
  let lastMilestone = "started";
  let waitingFor = "setup";
  let waitingSince = started;
  let completed = false;
  const report = (event: string) => {
    const now = performance.now();
    t.diagnostic(
      JSON.stringify({
        fixture,
        event,
        lastMilestone,
        waitingFor,
        elapsedMs: Math.round(now - started),
        waitingMs: Math.round(now - waitingSince),
      }),
    );
  };
  const aborted = () => {
    if (!completed) report("aborted");
  };
  t.signal.addEventListener("abort", aborted, { once: true });
  t.after(() => t.signal.removeEventListener("abort", aborted));
  report("started");
  return {
    reached(milestone: string) {
      lastMilestone = milestone;
      report("reached");
    },
    waiting(milestone: string) {
      waitingFor = milestone;
      waitingSince = performance.now();
      report("waiting");
    },
    complete() {
      completed = true;
      waitingFor = "none";
      report("completed");
    },
  };
}
