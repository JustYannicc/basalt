import { historyObject, invalidHistory } from "./record.ts";

export interface ServingRoute {
  route: string;
  streamMode: "stream" | "non-stream" | "not-applicable";
  successful: number;
  failures: number;
  serverErrors: number;
  total: number;
  p99Ms: number | null;
}
export interface ServingWindow {
  from: number;
  to: number;
  routes: ServingRoute[];
}
export interface ServingObservation {
  source: string;
  kind: "model-completion" | "serving-dependency";
  available: boolean;
  observedAt: number;
  computedAt: number;
  baseline?: ServingWindow & { nonRelease: true };
  window?: ServingWindow;
}
const integer = (value: unknown) => {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0)
    return invalidHistory();
  return value;
};
function window(raw: unknown): ServingWindow {
  const value = historyObject(raw);
  const from = integer(value.from),
    to = integer(value.to);
  if (
    to - from !== 300_000 ||
    !Array.isArray(value.routes) ||
    !value.routes.length ||
    value.routes.length > 64
  )
    return invalidHistory();
  const keys = new Set<string>();
  const routes = value.routes.map((raw): ServingRoute => {
    const row = historyObject(raw);
    if (
      typeof row.route !== "string" ||
      !/^\/[A-Za-z0-9_/:.{}-]{0,255}$/.test(row.route) ||
      !["stream", "non-stream", "not-applicable"].includes(String(row.streamMode))
    )
      return invalidHistory();
    const key = `${row.route}:${row.streamMode}`;
    if (keys.has(key)) return invalidHistory();
    keys.add(key);
    const successful = integer(row.successful),
      failures = integer(row.failures),
      serverErrors = integer(row.serverErrors),
      total = integer(row.total);
    if (
      successful + failures !== total ||
      serverErrors > failures ||
      (row.p99Ms !== null &&
        (typeof row.p99Ms !== "number" || !Number.isFinite(row.p99Ms) || row.p99Ms < 0))
    )
      return invalidHistory();
    return {
      route: row.route,
      streamMode: row.streamMode as ServingRoute["streamMode"],
      successful,
      failures,
      serverErrors,
      total,
      p99Ms: row.p99Ms as number | null,
    };
  });
  return { from, to, routes };
}
export function servingObservation(raw: unknown): ServingObservation | undefined {
  if (raw === undefined) return undefined;
  const value = historyObject(raw);
  if (
    typeof value.source !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(value.source) ||
    !["model-completion", "serving-dependency"].includes(String(value.kind)) ||
    typeof value.available !== "boolean"
  )
    return invalidHistory();
  const baseline = value.baseline === undefined ? undefined : window(value.baseline);
  if (baseline && historyObject(value.baseline).nonRelease !== true) return invalidHistory();
  const current = value.window === undefined ? undefined : window(value.window);
  if (
    value.kind === "model-completion" &&
    [...(baseline?.routes ?? []), ...(current?.routes ?? [])].some(
      (row) => row.streamMode === "not-applicable",
    )
  )
    return invalidHistory();
  return {
    source: value.source,
    kind: value.kind as ServingObservation["kind"],
    available: value.available,
    observedAt: integer(value.observedAt),
    computedAt: integer(value.computedAt),
    ...(baseline ? { baseline: { ...baseline, nonRelease: true as const } } : {}),
    ...(current ? { window: current } : {}),
  };
}
