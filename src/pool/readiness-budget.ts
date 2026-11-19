import { poolLifecycle } from "./lifecycle.ts";
import { forcedStopGraceMs } from "./runtime-slots/forced-stop.ts";
import { unservingBoundMs } from "./runtime-slots/unserving-clock.ts";

/**
 * The platform may keep an active controller object on its previous code for 300 seconds after an
 * upload. Thirty more cover transport.
 * https://developers.cloudflare.com/durable-objects/deployments/durable-objects-code-updates/
 */
export const controllerAdoptionMs = 330_000;
/**
 * The controller's waits that carry no name: two alarm turns, the warm read, two exit reads, the
 * provider call and a start's tail come to 25 seconds. The rest is for the container's destroy
 * and one membership pass, which have no bound of their own.
 */
export const controllerHealAllowanceMs = 90_000;
/** How long the controller may take to replace a running runtime that keeps refusing. */
export const runtimeHealMs =
  unservingBoundMs + forcedStopGraceMs + poolLifecycle.startupTimeoutMs + controllerHealAllowanceMs;
/** Readiness waits for the object to adopt the uploaded code, then for the controller's heal. */
export const readinessWaitMs = controllerAdoptionMs + runtimeHealMs;
/** Five seconds keep the receipt and teardown outside the wait. */
export const readinessCommandSeconds = (readinessWaitMs + 5_000) / 1_000;
