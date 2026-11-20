import { Effect, Redacted, Schema } from "effect";
import { HttpClient, HttpClientRequest } from "effect/http";
import { databasePoolParameters } from "../../.upstream/apps/hosted/cloud/src/infrastructure/database-pool-policy.ts";

/**
 * The settings the apply's first database step, `RuntimeDatabaseBudget`, compares, plus the two the
 * pooler and the release envelope depend on. `max_connections` is the release's connection
 * envelope; the pool policy does not declare it yet.
 */
export const declaredPoolParameters: ReadonlyArray<{
  namespace: string;
  name: string;
  declared: string;
}> = [
  ...Object.entries(databasePoolParameters).map(([name, declared]) => ({
    namespace: "pgbouncer",
    name,
    declared,
  })),
  { namespace: "pgbouncer", name: "pool_mode", declared: "transaction" },
  { namespace: "pgconf", name: "max_connections", declared: "50" },
];

const Rows = Schema.Array(
  Schema.Struct({ namespace: Schema.String, name: Schema.String, value: Schema.Unknown }),
);

const jsonType = (value: unknown) =>
  value === null ? "null" : value === undefined ? "absent" : typeof value;

/**
 * Each declared setting against what the provider returned, compared the way the budget step does
 * (strict equality with the declared string), with the JSON type it arrived as. Rows the provider
 * returns under any other name never enter the report.
 */
export function poolParameterReport(
  rows: ReadonlyArray<{ namespace: string; name: string; value: unknown }>,
) {
  const settings = declaredPoolParameters.map(({ namespace, name, declared }) => {
    const value = rows.find((row) => row.namespace === namespace && row.name === name)?.value;
    const type = jsonType(value);
    return {
      setting: `${namespace}.${name}`,
      declared,
      // Only plain, short settings reach the report; anything else is shown by its type alone.
      value:
        (type === "string" && (value as string).length <= 32) ||
        type === "number" ||
        type === "boolean"
          ? value
          : null,
      type,
      status: value === declared ? ("equal" as const) : ("differs" as const),
    };
  });
  // The budget step patches the pooler when any of its own values differ, which reloads it.
  const poolerReload = settings.some(
    (entry) =>
      entry.status === "differs" &&
      entry.setting.startsWith("pgbouncer.") &&
      entry.setting !== "pgbouncer.pool_mode",
  );
  // Without transaction pooling the budget step refuses instead of writing.
  const budgetRefuses =
    settings.find((entry) => entry.setting === "pgbouncer.pool_mode")?.status === "differs";
  return { settings, poolerReload, budgetRefuses };
}

/** One GET of the branch's parameters; this function sends nothing else. */
export const readPoolParameters = (input: {
  organization: string;
  tokenId: Redacted.Redacted<string>;
  token: Redacted.Redacted<string>;
  database: string;
  branch: string;
  apiOrigin?: string;
}) =>
  Effect.gen(function* () {
    const client = (yield* HttpClient.HttpClient).pipe(HttpClient.filterStatusOk);
    const url = `${input.apiOrigin ?? "https://api.planetscale.com/v1"}/organizations/${encodeURIComponent(input.organization)}/databases/${encodeURIComponent(input.database)}/branches/${encodeURIComponent(input.branch)}/parameters`;
    const response = yield* client.execute(
      HttpClientRequest.get(url).pipe(
        HttpClientRequest.setHeader(
          "authorization",
          `${Redacted.value(input.tokenId)}:${Redacted.value(input.token)}`,
        ),
      ),
    );
    return poolParameterReport(yield* Schema.decodeUnknownEffect(Rows)(yield* response.json));
  });

/** The public line: settings and values only, never a host, id or token. */
export const poolParameterLine = (report: ReturnType<typeof poolParameterReport>) =>
  [
    `Pool parameters: ${report.settings
      .map(
        (entry) =>
          `${entry.setting} ${entry.status} (${JSON.stringify(entry.value)}, ${entry.type})`,
      )
      .join("; ")}`,
    ...(report.poolerReload
      ? [
          "Warning: a PgBouncer setting differs from the policy, so the apply's first database step (RuntimeDatabaseBudget) would PATCH it and reload the pooler while the old Worker serves.",
        ]
      : []),
    ...(report.budgetRefuses
      ? [
          "Warning: PgBouncer is not in transaction pooling, so the apply's first database step (RuntimeDatabaseBudget) would refuse.",
        ]
      : []),
  ].join("\n");
