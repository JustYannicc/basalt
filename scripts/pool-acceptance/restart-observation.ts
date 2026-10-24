import {
  AcceptanceFailure,
  HttpStatusFailure,
  TransportFailure,
  type ModelCatalog,
} from "./types.ts";
import type { PoolAcceptanceClient } from "./client.ts";

const restartWindowMs = 12 * 60 * 1_000;
const pollDelayMs = 5_000;
const defaultProbeTimeoutMs = 5_000;

type RestartOptions = {
  readonly now?: () => number;
  readonly delay?: (ms: number) => Promise<void>;
  readonly windowMs?: number;
  readonly pollDelayMs?: number;
  readonly probeTimeoutMs?: number;
  readonly log?: (message: string) => void;
};

type RestartInput = {
  readonly client: PoolAcceptanceClient;
  readonly apiKey: string;
  readonly model: string;
  readonly baseline: ModelCatalog;
  readonly options?: RestartOptions;
};

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function observeRestart({ client, apiKey, model, baseline, options = {} }: RestartInput): Promise<{
  boot: string;
}> {
  const now = options.now ?? (() => performance.now());
  const wait = options.delay ?? delay;
  const windowMs = options.windowMs ?? restartWindowMs;
  const pollDelayAfterProbeMs = options.pollDelayMs ?? pollDelayMs;
  const probeTimeoutMs = options.probeTimeoutMs ?? defaultProbeTimeoutMs;
  const log = options.log ?? console.log;

  log(`restart_observation status=armed window_seconds=${windowMs / 1_000} poll_delay_after_probe_ms=${pollDelayAfterProbeMs} external_trigger=required`);
  const observationStartedAt = now();
  const deadline = observationStartedAt + windowMs;
  let lastOldBootResponseAt = baseline.completedAt;
  let firstUnavailableAt: number | undefined;
  let firstUnavailableStatus: number | "network" | undefined;
  let firstHttp200AfterFailureAt: number | undefined;
  let firstHttp200BootChanged: boolean | undefined;
  let previousProbeStartedAt: number | undefined;
  let minProbeGapMs = Number.POSITIVE_INFINITY;
  let maxProbeGapMs = 0;
  let polls = 0;
  let unavailable = 0;

  while (now() < deadline) {
    const remainingBeforeDelay = deadline - now();
    await wait(Math.min(pollDelayAfterProbeMs, remainingBeforeDelay));
    const remaining = deadline - now();
    if (remaining <= 0) break;
    polls += 1;
    const probeStartedAt = now();
    if (previousProbeStartedAt !== undefined) {
      const gap = probeStartedAt - previousProbeStartedAt;
      minProbeGapMs = Math.min(minProbeGapMs, gap);
      maxProbeGapMs = Math.max(maxProbeGapMs, gap);
    }
    previousProbeStartedAt = probeStartedAt;

    let catalog: ModelCatalog;
    try {
      catalog = await client.modelCatalog(apiKey, Math.max(1, Math.min(probeTimeoutMs, remaining)));
    } catch (error) {
      if (error instanceof HttpStatusFailure) {
        if (error.status < 500 || error.status > 599) throw error;
      } else if (!(error instanceof TransportFailure)) {
        throw error;
      }
      const unavailableAt = now();
      unavailable += 1;
      firstUnavailableAt ??= unavailableAt;
      firstUnavailableStatus ??= error instanceof HttpStatusFailure ? error.status : "network";
      continue;
    }

    if (!catalog.ids.includes(model)) {
      throw new AcceptanceFailure("/v1/models restart probe omitted the selected model");
    }
    if (catalog.boot === baseline.boot) {
      if (firstUnavailableAt !== undefined && firstHttp200AfterFailureAt === undefined) {
        firstHttp200AfterFailureAt = catalog.completedAt;
        firstHttp200BootChanged = false;
      }
      lastOldBootResponseAt = catalog.completedAt;
      continue;
    }

    if (firstUnavailableAt !== undefined && firstHttp200AfterFailureAt === undefined) {
      firstHttp200AfterFailureAt = catalog.completedAt;
      firstHttp200BootChanged = true;
    }
    const transitionDetectionMs = catalog.completedAt - lastOldBootResponseAt;
    const failureToFirst200Ms = firstUnavailableAt === undefined || firstHttp200AfterFailureAt === undefined
      ? undefined
      : firstHttp200AfterFailureAt - firstUnavailableAt;
    log(
      `restart_observation status=boot_changed polls=${polls} unavailable=${unavailable} new_boot_catalog_observation_elapsed_ms=${Math.round(catalog.completedAt - observationStartedAt)} poll_delay_after_probe_ms=${pollDelayAfterProbeMs}`,
    );
    if (Number.isFinite(minProbeGapMs)) {
      log(`restart_probe_gaps count=${polls - 1} min_ms=${Math.round(minProbeGapMs)} max_ms=${Math.round(maxProbeGapMs)}`);
    }
    if (failureToFirst200Ms === undefined) {
      log(`restart_recovery status=bounded failure_observed=false boot_change_detection_interval_ms=${Math.round(transitionDetectionMs)}`);
    } else {
      log(`restart_recovery status=observed first_unavailable_status=${firstUnavailableStatus} first_failure_to_first_200_ms=${Math.round(failureToFirst200Ms)} first_200_boot_changed=${firstHttp200BootChanged} boot_change_detection_interval_ms=${Math.round(transitionDetectionMs)}`);
    }
    return { boot: catalog.boot };
  }

  log(`restart_observation status=timeout polls=${polls} unavailable=${unavailable} window_seconds=${windowMs / 1_000} poll_delay_after_probe_ms=${pollDelayAfterProbeMs}`);
  if (Number.isFinite(minProbeGapMs)) {
    log(`restart_probe_gaps count=${polls - 1} min_ms=${Math.round(minProbeGapMs)} max_ms=${Math.round(maxProbeGapMs)}`);
  }
  throw new AcceptanceFailure("No changed pool boot and valid model catalog appeared in the restart window");
}

