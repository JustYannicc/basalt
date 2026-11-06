import { Schema } from "effect";

export const releaseDatabasePolicy = {
  // A provider-side limit change cannot silently expand the approved release envelope.
  maxConnections: 25,
  // The metrics API exposes max_connections, but no verified reserved-slot gauge.
  superuserReservedConnections: 3,
  reservedConnections: 0,
  connections: {
    productMigration: 1,
    betterAuthMigration: 2,
    poolProvisioning: 2,
    toolsVerifier: 1,
    poolVerifier: 1,
  },
  maxResponseAgeMs: 30_000,
  requestTimeoutMs: 10_000,
} as const;

const metricNames = [
  "planetscale_postgres_connection_state",
  "planetscale_postgres_settings_max_connections",
] as const;
const count = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));
const Metrics = Schema.Struct({
  branch: Schema.Struct({ name: Schema.String }),
  metrics: Schema.Array(
    Schema.Struct({
      metric: Schema.String,
      values: Schema.Array(
        Schema.Struct({
          pod: Schema.String,
          role: Schema.Literals(["primary", "replica"]),
          value: count,
        }),
      ),
    }),
  ),
});

export function primaryHeadroom(value: unknown, branch: string, policy = releaseDatabasePolicy) {
  let metrics: typeof Metrics.Type;
  try {
    metrics = Schema.decodeUnknownSync(Metrics)(value);
  } catch {
    throw new Error("Database preflight refused: invalid PlanetScale primary metrics.");
  }
  if (metrics.branch.name !== branch)
    throw new Error("Database preflight refused: metrics belong to a different branch.");
  const primary = metricNames.map((name) => {
    const rows = metrics.metrics.filter((metric) => metric.metric === name);
    const values = rows.flatMap((row) => row.values.filter((sample) => sample.role === "primary"));
    if (rows.length !== 1 || values.length !== 1 || !values[0]!.pod)
      throw new Error(`Database preflight refused: ${name} needs exactly one primary sample.`);
    return values[0]!;
  });
  if (primary[0]!.pod !== primary[1]!.pod)
    throw new Error("Database preflight refused: primary metrics disagree on the pod.");
  const observed = primary[0]!.value;
  const ordinarySlots =
    primary[1]!.value - policy.superuserReservedConnections - policy.reservedConnections;
  const envelope = Object.values(policy.connections).reduce((sum, cap) => sum + cap, 0);
  if (primary[1]!.value !== policy.maxConnections)
    throw new Error(
      `Database preflight refused: primary total ${observed}, release envelope ${envelope}, ordinary slots ${ordinarySlots} ` +
        `(max ${primary[1]!.value}, configured max ${policy.maxConnections}). No deployment has started. ` +
        "The connection limits need an explicit configuration review before retrying.",
    );
  if (ordinarySlots <= 0 || envelope <= 0 || observed + envelope > ordinarySlots)
    throw new Error(
      `Database preflight refused: primary total ${observed}, release envelope ${envelope}, ordinary slots ${ordinarySlots} ` +
        `(max ${primary[1]!.value}, superuser reserved ${policy.superuserReservedConnections}, reserved ${policy.reservedConnections}). ` +
        "No deployment has started. Wait for connection headroom before retrying.",
    );
  return { observed, ordinarySlots, envelope };
}

/** An instant HTTP read opens no Postgres session and cannot change provider settings. */
export async function checkReleaseHeadroom(
  environment: NodeJS.ProcessEnv,
  options: { fetch?: typeof fetch; now?: () => number } = {},
) {
  const required = (name: string) => {
    const value = environment[name];
    if (!value?.trim()) throw new Error(`Database preflight requires ${name}.`);
    return value;
  };
  const organization = required("PLANETSCALE_ORGANIZATION");
  const database = required("PLANETSCALE_DATABASE_NAME");
  const branch = "main";
  const url = new URL(
    `https://api.planetscale.com/v1/organizations/${encodeURIComponent(organization)}/databases/${encodeURIComponent(database)}/branches/${branch}/metrics/instant`,
  );
  for (const metric of metricNames) url.searchParams.append("metrics[]", metric);
  const authorization = `${required("PLANETSCALE_API_TOKEN_ID")}:${required("PLANETSCALE_API_TOKEN")}`;
  let response: Response;
  try {
    response = await (options.fetch ?? fetch)(url, {
      headers: { authorization, "cache-control": "no-cache" },
      signal: AbortSignal.timeout(releaseDatabasePolicy.requestTimeoutMs),
      redirect: "error",
    });
  } catch {
    throw new Error(
      "Database preflight refused: PlanetScale metrics request failed; no deployment has started.",
    );
  }
  if (response.status !== 200)
    throw new Error(
      `Database preflight refused: PlanetScale metrics returned HTTP ${response.status}.`,
    );
  const now = (options.now ?? Date.now)();
  const date = Date.parse(response.headers.get("date") ?? "");
  const age = Number(response.headers.get("age") ?? "0");
  // Instant samples have no source timestamp. These checks establish HTTP response freshness only.
  if (
    !Number.isFinite(date) ||
    !Number.isFinite(age) ||
    age < 0 ||
    now - date > releaseDatabasePolicy.maxResponseAgeMs ||
    date - now > releaseDatabasePolicy.maxResponseAgeMs ||
    age * 1000 > releaseDatabasePolicy.maxResponseAgeMs
  )
    throw new Error("Database preflight refused: missing or stale PlanetScale metrics response.");
  let value: unknown;
  try {
    value = await response.json();
  } catch {
    throw new Error("Database preflight refused: PlanetScale metrics response is not JSON.");
  }
  return primaryHeadroom(value, branch);
}
