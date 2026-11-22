/**
 * The forced restart's timing, in one module with no imports, so release tooling can derive its
 * readiness and acceptance bounds from the numbers the controller runs on. Every value is in
 * milliseconds unless its name says otherwise.
 */

/** A selected runtime that runs but refuses this long, with no successful read between, is stopped. */
export const unservingBoundMs = 60_000;
/** Forced restarts allowed per hour, counted by the controller. */
export const forcedRestartsPerHour = 3;
/** Forced stops allowed per hour, counted again by the container's own object before the signal. */
export const forcedStopsPerHour = 3;
/**
 * Streams counted active hold a forced stop until their count has stood still this long, counted
 * from the last stream change or the first refusal. A live long turn and a leaked count look alike.
 */
export const leakedStreamsMs = 300_000;
/**
 * After SIGTERM the supervisor gives its children 15 s, then kills them and waits 1 s
 * (`terminate_children` in containers/pool/supervisor.py). A test keeps the two in step.
 */
export const supervisorStopGraceMs = 16_000;
/** How long SIGTERM gets before `destroy()`: longer than the supervisor's own grace. */
export const forcedStopGraceMs = 30_000;
/** The wait between the two "not running" reads that admit a restart, and again before its start. */
export const exitConfirmationMs = 2_000;
/** The container's startup allowance (`poolLifecycle.startupTimeoutMs`; a test keeps them equal). */
export const runtimeStartupMs = 180_000;
/**
 * A restart's own start answers readiness within this of its admission, or its startup deadline has
 * passed. Past it, a container under that restart that doesn't answer is taken for the old one; a
 * forced restart's own start is never stopped again, whatever it answers.
 */
export const restartStartBoundMs = runtimeStartupMs + 60_000;
/** The outer bound on the stop's own health and readiness reads. */
export const servingReadMs = 10_000;
/** A readiness read gives up after its lease window, whatever the caller allows. */
export const readinessReadMs = 1_500;
/** Recovery runs on the fleet upkeep alarm about this often. */
export const recoveryPassMs = 2_000;
/** Recovery's warm read of the selected runtime gives up after this. */
export const recoveryWarmMs = 2_000;
/** Allowances, not enforced limits: one provider read, and the steps between start and ready. */
export const providerReadAllowanceMs = 1_000;
export const restartTailAllowanceMs = 14_000;

/**
 * Worst case from the first refusal the new code sees to a serving runtime, with no streams held,
 * excluding the time `destroy()` takes and the membership pass that renews an expired pool policy.
 */
export const forcedRestartServesWithinMs =
  recoveryPassMs +
  unservingBoundMs +
  recoveryWarmMs +
  2 * readinessReadMs +
  forcedStopGraceMs +
  2 * exitConfirmationMs +
  providerReadAllowanceMs +
  runtimeStartupMs +
  restartTailAllowanceMs +
  recoveryPassMs;
/** The same, when a non-zero stream count stands still: the stop waits out `leakedStreamsMs`. */
export const forcedRestartServesWithinHeldStreamsMs =
  forcedRestartServesWithinMs - unservingBoundMs + Math.max(unservingBoundMs, leakedStreamsMs);

/**
 * What the totals above leave out: the time `destroy()` takes, and the one membership pass that
 * renews an expired pool policy before recovery reports ready. An allowance, until a stage heal's
 * stop path measures both.
 */
export const destroyAndMembershipMs = 120_000;
/**
 * A restart that hasn't reached ready this long after it began has failed: needs a person. A forced
 * restart begins at its stop; one recovery tries on its own, at its first try since serving. It is
 * the forced restart's worst case from its stop to ready, with `destroy()` and the membership pass,
 * which also covers recovery's own restart, so a slow but healthy restart never pages a person.
 */
export const forcedRestartBudgetMs =
  forcedStopGraceMs +
  2 * exitConfirmationMs +
  providerReadAllowanceMs +
  runtimeStartupMs +
  restartTailAllowanceMs +
  recoveryPassMs +
  destroyAndMembershipMs;
/**
 * The platform may keep an active controller object on its previous code for 300 seconds after an
 * upload; thirty more cover transport. The new code's recovery runs only once the object adopts it.
 * https://developers.cloudflare.com/durable-objects/deployments/durable-objects-code-updates/
 */
export const controllerAdoptionMs = 330_000;
/**
 * A healing release's acceptance waits this long for recovery to report ready on a new boot. It
 * budgets a stream count that stands still, since nothing can read the old boot's count before the
 * apply.
 */
export const healingAcceptanceWithinMs =
  forcedRestartServesWithinHeldStreamsMs + destroyAndMembershipMs;
/** Readiness after the pool Worker's upload: the object adopts the new code, then the heal runs. */
export const healingReadinessWithinMs = controllerAdoptionMs + healingAcceptanceWithinMs;
