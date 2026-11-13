import {
  servingObservation,
  type ServingObservation,
  type ServingRoute,
  type ServingWindow,
} from "./bulk-serving-contract.ts";
import { historyObject, invalidHistory } from "./record.ts";

interface Threshold {
  route: string;
  streamMode: ServingRoute["streamMode"];
  successful: number;
  total: number;
  p99Ms: number;
  maximumP99Ms: number;
  failureRate: number;
  maximumFailureRate: number;
  zeroServerErrors: boolean;
  sampleQuality: "noisy" | "preferred";
}
export interface ServingState {
  source: string | null;
  kind: ServingObservation["kind"] | null;
  status: "not available" | "available" | "unavailable" | "stale" | "regressed";
  baseline: ServingObservation["baseline"] | null;
  thresholds: Threshold[];
  window: ServingWindow | null;
  observedAt: number | null;
  computedAt: number | null;
  regressionAt: number | null;
  consecutiveRegressions: number;
}
export const initialServing = (): ServingState => ({
  source: null,
  kind: null,
  status: "not available",
  baseline: null,
  thresholds: [],
  window: null,
  observedAt: null,
  computedAt: null,
  regressionAt: null,
  consecutiveRegressions: 0,
});
const sameRoute = (
  a: Pick<ServingRoute, "route" | "streamMode">,
  b: Pick<ServingRoute, "route" | "streamMode">,
) => a.route === b.route && a.streamMode === b.streamMode;
const thresholds = (baseline: NonNullable<ServingObservation["baseline"]>): Threshold[] =>
  baseline.routes.map((row) => ({
    route: row.route,
    streamMode: row.streamMode,
    successful: row.successful,
    total: row.total,
    p99Ms: row.p99Ms!,
    maximumP99Ms: Math.max(1.25 * row.p99Ms!, row.p99Ms! + 100),
    failureRate: row.failures / row.total,
    maximumFailureRate: row.failures / row.total + 0.01,
    zeroServerErrors: row.serverErrors === 0,
    sampleQuality: row.successful >= 100 ? "preferred" : "noisy",
  }));

export function parseServingState(raw: unknown): ServingState {
  const value = historyObject(raw);
  if (
    !["not available", "available", "unavailable", "stale", "regressed"].includes(
      String(value.status),
    )
  )
    return invalidHistory();
  const nullable = (value: unknown) => {
    if (value === null) return null;
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0)
      return invalidHistory();
    return value;
  };
  const count = nullable(value.consecutiveRegressions);
  if (count === null) return invalidHistory();
  if (value.source === null) {
    if (
      value.status !== "not available" ||
      value.kind !== null ||
      value.baseline !== null ||
      value.window !== null
    )
      return invalidHistory();
    return initialServing();
  }
  const parsed = servingObservation({
    source: value.source,
    kind: value.kind,
    available: false,
    observedAt: value.observedAt ?? 0,
    computedAt: value.computedAt ?? 0,
    ...(value.baseline === null ? {} : { baseline: value.baseline }),
    ...(value.window === null ? {} : { window: value.window }),
  })!;
  const frozen = parsed.baseline ? thresholds(parsed.baseline) : [];
  if (JSON.stringify(value.thresholds) !== JSON.stringify(frozen)) return invalidHistory();
  return {
    source: parsed.source,
    kind: parsed.kind,
    status: value.status as ServingState["status"],
    baseline: parsed.baseline ?? null,
    thresholds: frozen,
    window: parsed.window ?? null,
    observedAt: nullable(value.observedAt),
    computedAt: nullable(value.computedAt),
    regressionAt: nullable(value.regressionAt),
    consecutiveRegressions: count,
  };
}

/** These tolerances are an engineering policy, not a measured guarantee of safe production load. */
export function observeServing(
  state: ServingState,
  observation: ServingObservation | undefined,
  now: number,
  startedAt: number,
) {
  const unavailable = (status: "unavailable" | "stale") => {
    state.status = status;
    state.consecutiveRegressions = 0;
    state.regressionAt = null;
    return status === "stale" ? "serving_stale" : "serving_unavailable";
  };
  if (!state.source && !observation) return null;
  if (!state.source && observation) {
    state.source = observation.source;
    state.kind = observation.kind;
  }
  if (
    !observation ||
    !observation.available ||
    observation.source !== state.source ||
    observation.kind !== state.kind
  ) {
    return unavailable(observation ? "unavailable" : "stale");
  }
  state.observedAt = observation.observedAt;
  if (
    observation.observedAt > now ||
    observation.computedAt > now ||
    now - observation.observedAt > 120_000 ||
    now - observation.computedAt > 120_000 ||
    !observation.window ||
    now - observation.window.to > 120_000 ||
    observation.window.to > observation.computedAt ||
    (state.computedAt !== null && observation.computedAt < state.computedAt)
  ) {
    return unavailable("stale");
  }
  if (observation.computedAt === state.computedAt) {
    if (JSON.stringify(observation.window) !== JSON.stringify(state.window))
      return unavailable("stale");
    return state.status === "available" ? null : `serving_${state.status}`;
  }
  if (!state.baseline) {
    const baseline = observation.baseline;
    if (
      !baseline ||
      baseline.to > startedAt ||
      baseline.routes.some((row) => row.successful < 20 || row.p99Ms === null)
    ) {
      return unavailable("unavailable");
    }
    state.baseline = structuredClone(baseline);
    state.thresholds = thresholds(baseline);
  }
  // A later observation cannot replace the frozen baseline or its per-route thresholds.
  const current = observation.window;
  state.window = structuredClone(current);
  const immediate = current.routes.some((row) =>
    state.thresholds.some((t) => sameRoute(t, row) && t.zeroServerErrors && row.serverErrors > 0),
  );
  const usable =
    current.routes.length === state.thresholds.length &&
    state.thresholds.every((t) =>
      current.routes.some((row) => sameRoute(t, row) && row.successful >= 20 && row.p99Ms !== null),
    );
  if (!usable && !immediate) {
    return unavailable("unavailable");
  }
  const regressed =
    immediate ||
    current.routes.some((row) =>
      state.thresholds.some(
        (t) =>
          sameRoute(t, row) &&
          (row.p99Ms! > t.maximumP99Ms || row.failures / row.total > t.maximumFailureRate),
      ),
    );
  if (observation.computedAt !== state.computedAt) {
    if (!regressed) {
      state.consecutiveRegressions = 0;
      state.regressionAt = null;
    } else if (
      state.regressionAt === null ||
      observation.computedAt - state.regressionAt >= 60_000
    ) {
      state.consecutiveRegressions++;
      state.regressionAt = observation.computedAt;
    }
    state.computedAt = observation.computedAt;
  }
  const needsHealthy = ["unavailable", "stale", "regressed"].includes(state.status);
  const pause = immediate || (regressed && (needsHealthy || state.consecutiveRegressions >= 2));
  state.status = pause ? "regressed" : "available";
  return pause ? "serving_regressed" : null;
}
