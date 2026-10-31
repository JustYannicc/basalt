import type { WorkflowStepContext } from "apps";
import { requirements } from "../common/installation.ts";
import { configuration } from "../common/configuration.ts";
import { api, instant, list, numeric, ReadUnavailable, record, text, tool } from "../common/api.ts";
import type { Checkpoint, Observation } from "../common/types.ts";
import {
  availabilityObservation,
  errorSpikeObservation,
  runtimeObservation,
  serviceErrorsObservation,
} from "./conditions.ts";
type Step = WorkflowStepContext<typeof requirements>;
const unknown = (at: number, code: string): Observation => ({
  cursor: `${code}:${at}`,
  at,
  code,
  verdict: "unknown",
  failures: 0,
  successes: 0,
  since: at,
});
export async function readRelease(step: Step): Promise<Observation> {
  const now = Date.now(),
    source = configuration.operator.release;
  if (source === null) return unknown(now, "release-source-unconfigured");
  try {
    const response = record(await tool(step, source));
    const runs = list(response?.workflow_runs)
      .map(record)
      .filter((run) => run?.workflow_id === source.workflowId && run.head_branch === source.branch)
      .sort((a, b) => (instant(b?.created_at) ?? 0) - (instant(a?.created_at) ?? 0));
    const run = runs[0],
      id = numeric(run?.id),
      attempt = numeric(run?.run_attempt),
      at = instant(run?.updated_at);
    if (
      !run ||
      id === undefined ||
      attempt === undefined ||
      at === undefined ||
      at > now ||
      run.status !== "completed"
    )
      return unknown(now, "release-not-terminal");
    const failed = ["failure", "timed_out", "action_required", "startup_failure"].includes(
      text(run.conclusion) ?? "",
    );
    const sha = text(run.head_sha);
    const evidenceUrl = /^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/.test(source.repository)
      ? `https://github.com/${source.repository}/actions/runs/${id}`
      : undefined;
    return {
      cursor: `release:${id}:${attempt}:${text(run.conclusion) ?? "unknown"}`,
      decision: `release:${id}:${attempt}`,
      at: now,
      sourceAt: at,
      ...(sha && /^[a-f0-9]{40,64}$/.test(sha) ? { attemptedSha: sha } : {}),
      ...(evidenceUrl === undefined ? {} : { evidenceUrl }),
      code: failed ? "production-release-failed" : "production-release",
      verdict: failed ? "action" : run.conclusion === "success" ? "healthy" : "unknown",
      failures: 0,
      successes: 0,
      since: at,
    };
  } catch {
    return unknown(now, "release-read-unavailable");
  }
}
export async function readAvailability(step: Step, previous: Checkpoint) {
  const now = Date.now(),
    source = configuration.operator.availability;
  if (source === null) return unknown(now, "availability-source-unconfigured");
  try {
    const url = new URL(source.publicUrl);
    if (url.protocol !== "https:" || url.username || url.password || url.search)
      return unknown(now, "public-read-unconfigured");
    const response = await step.fetch(url, {
      redirect: "manual",
      signal: AbortSignal.any([step.signal, AbortSignal.timeout(10000)]),
    });
    // A refused credential or quota does not establish an outage.
    if ([401, 403, 429].includes(response.status))
      return availabilityObservation(now, "unknown", previous);
    const publicOk = response.status === 200;
    const backend = record(await api(step, "GET", "inventory"));
    if (!Array.isArray(backend?.apps) || !Array.isArray(backend?.accounts))
      return availabilityObservation(now, "unknown", previous);
    return availabilityObservation(now, publicOk ? "healthy" : "failed", previous);
  } catch (error) {
    return availabilityObservation(
      now,
      error instanceof ReadUnavailable && error.status > 0 && error.status < 500
        ? "unknown"
        : "failed",
      previous,
    );
  }
}
/** These projections must come from a verified existing metrics query. Missing fields stay unknown. */
export async function readRuntime(step: Step, previous: Checkpoint) {
  const now = Date.now(),
    source = configuration.operator.runtime;
  if (source === null) return unknown(now, "runtime-metrics-unconfigured");
  try {
    const value = record(await tool(step, source)),
      at = instant(value?.at),
      startedAt = instant(value?.startedAt),
      boot = text(value?.boot);
    const boots = list(value?.unexpectedBoots).map(instant);
    if (
      !value ||
      at === undefined ||
      startedAt === undefined ||
      !boot ||
      !/^[a-zA-Z0-9_.:-]{1,128}$/.test(boot) ||
      typeof value.ready !== "boolean" ||
      value.excludesExpectedRestarts !== true ||
      !Array.isArray(value.unexpectedBoots) ||
      boots.some((at) => at === undefined) ||
      at > now ||
      now - at > 2 * 60000 ||
      startedAt > at
    )
      return unknown(now, "runtime-evidence-incomplete");
    return runtimeObservation(
      {
        at,
        startedAt,
        boot,
        ready: value.ready,
        unexpectedBoots: boots.filter((at): at is number => at !== undefined),
      },
      previous,
    );
  } catch {
    return unknown(now, "runtime-read-unavailable");
  }
}
export async function readServiceErrors(step: Step) {
  const now = Date.now(),
    source = configuration.operator.httpErrors;
  if (source === null) return unknown(now, "unsampled-http-denominator-unconfigured");
  try {
    const value = record(await tool(step, source));
    if (
      value?.production !== true ||
      value.unsampled !== true ||
      value.excludesExpectedRefusalsAndProbes !== true
    )
      return unknown(now, "http-denominator-incomplete");
    const buckets = list(value.buckets).map(record);
    if (
      buckets.some(
        (bucket) =>
          instant(bucket?.start) === undefined ||
          numeric(bucket?.requests) === undefined ||
          numeric(bucket?.errors) === undefined,
      )
    )
      return unknown(now, "http-buckets-incomplete");
    return serviceErrorsObservation(
      now,
      buckets.map((bucket) => ({
        start: instant(bucket?.start)!,
        requests: numeric(bucket?.requests)!,
        errors: numeric(bucket?.errors)!,
      })),
    );
  } catch {
    return unknown(now, "http-metrics-unavailable");
  }
}
export async function readErrorSpike(step: Step, previous: Checkpoint) {
  const now = Date.now(),
    source = configuration.operator.errorCounts;
  if (source === null) return unknown(now, "error-event-counts-unconfigured");
  try {
    const value = record(await tool(step, source)),
      at = instant(value?.at),
      events = numeric(value?.events),
      priorHour = value?.priorHour === null ? null : numeric(value?.priorHour);
    if (
      !value ||
      value.production !== true ||
      value.excludesFeedbackAndExpectedRefusals !== true ||
      value.intervalMs !== 5 * 60000 ||
      at === undefined ||
      at > now ||
      now - at > 5 * 60000 ||
      events === undefined ||
      events < 0 ||
      priorHour === undefined ||
      (priorHour !== null && priorHour < 0)
    )
      return unknown(now, "error-count-evidence-incomplete");
    return errorSpikeObservation(at, events, priorHour, previous);
  } catch {
    return unknown(now, "error-counts-unavailable");
  }
}
export { readWorkflowHealth } from "./workflow-health.ts";
