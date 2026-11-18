import { Data, Duration, Effect, Redacted, Schedule, Schema } from "effect";
import { HttpClient, HttpClientRequest } from "effect/http";
import type { StateService } from "alchemy/State/State";
import pg from "pg";
import { clientConfig } from "../pool-database-provisioning.ts";

/** One refusal type for the database checks; `detail` names the exact values compared. */
export class DatabaseSafetyRefusal extends Data.TaggedError("DatabaseSafetyRefusal")<{
  readonly check: string;
  readonly why: string;
  readonly fix: string;
  readonly detail?: Record<string, unknown>;
  readonly cause?: unknown;
}> {
  override get message() {
    return `${this.check}: ${this.why}${this.detail ? ` ${JSON.stringify(this.detail)}` : ""}`;
  }
}

export interface Session {
  query(text: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
}

const count = Schema.NumberFromString.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0));
const HomeSchema = Schema.Struct({
  schema: Schema.String,
  accounts: Schema.Number,
  schemaVersion: Schema.NullOr(Schema.Number),
});
export const DatabaseSnapshot = Schema.Struct({
  homes: Schema.Array(HomeSchema),
  /** Null when skipped: a count over millions of rows is not taken against a busy database. */
  historyRows: Schema.NullOr(Schema.Number),
});
export type DatabaseSnapshot = typeof DatabaseSnapshot.Type;

const refuse = (check: string, why: string, fix: string, detail?: Record<string, unknown>) =>
  new DatabaseSafetyRefusal({ check, why, fix, ...(detail ? { detail } : {}) });
const quote = (name: string) => `"${name.replaceAll('"', '""')}"`;

/** Accounts and history counts plus Home's own schema version, read in one read-only snapshot. */
export const readSnapshot = (session: Session, options: { history?: boolean } = {}) =>
  Effect.tryPromise({
    try: async () => {
      await session.query("BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
      try {
        await session.query("SET LOCAL statement_timeout = '60s'");
        const tables = async (name: string) =>
          (
            await session.query(
              "SELECT table_schema AS schema FROM information_schema.tables WHERE table_name = $1 ORDER BY 1",
              [name],
            )
          ).rows.map((row) => String(row.schema));
        const versions = new Set(await tables("home_schema_migration"));
        const homes = [];
        for (const schema of await tables("auth")) {
          const accounts = await session.query(
            `SELECT count(*) FILTER (WHERE deleted_at IS NULL)::text AS n FROM ${quote(schema)}.auth`,
          );
          const version = versions.has(schema)
            ? await session.query(
                `SELECT max(version)::text AS v FROM ${quote(schema)}.home_schema_migration`,
              )
            : undefined;
          const raw = version?.rows[0]?.v;
          homes.push({
            schema,
            accounts: Schema.decodeUnknownSync(count)(accounts.rows[0]?.n),
            schemaVersion: raw === undefined || raw === null ? null : Number(raw),
          });
        }
        if (options.history === false) {
          await session.query("COMMIT");
          return Schema.decodeUnknownSync(DatabaseSnapshot)({ homes, historyRows: null });
        }
        const history = await tables("basalt_model_requests");
        if (history.length !== 1)
          throw refuse(
            "history-table",
            "expected exactly one history table",
            "check the pool database",
            {
              schemas: history,
            },
          );
        const rows = await session.query(
          `SELECT count(*)::text AS n FROM ${quote(history[0]!)}.basalt_model_requests`,
        );
        await session.query("COMMIT");
        return Schema.decodeUnknownSync(DatabaseSnapshot)({
          homes,
          historyRows: Schema.decodeUnknownSync(count)(rows.rows[0]?.n),
        });
      } catch (error) {
        await session.query("ROLLBACK").catch(() => {});
        throw error;
      }
    },
    catch: (cause) =>
      cause instanceof DatabaseSafetyRefusal
        ? cause
        : new DatabaseSafetyRefusal({
            check: "snapshot-read",
            why: "the read-only counts could not be read",
            fix: "rerun; if it persists, the deploy must not start",
            cause,
          }),
  });

/** Counts may only grow, and Home's schema version may not move unless the caller expects it. */
export function compareSnapshots(
  before: DatabaseSnapshot,
  after: DatabaseSnapshot,
  options: { schemaChangeAllowed: boolean } = { schemaChangeAllowed: false },
) {
  const problems: Record<string, unknown>[] = [];
  const schemas = (value: DatabaseSnapshot) => value.homes.map((home) => home.schema).join(",");
  if (schemas(before) !== schemas(after))
    problems.push({ check: "home-schemas", before: schemas(before), after: schemas(after) });
  for (const home of before.homes) {
    const next = after.homes.find((value) => value.schema === home.schema);
    if (!next) continue;
    if (next.accounts < home.accounts)
      problems.push({
        check: "accounts",
        schema: home.schema,
        before: home.accounts,
        after: next.accounts,
      });
    if (!options.schemaChangeAllowed && next.schemaVersion !== home.schemaVersion)
      problems.push({
        check: "home-schema-version",
        schema: home.schema,
        before: home.schemaVersion,
        after: next.schemaVersion,
      });
  }
  if (
    before.historyRows !== null &&
    after.historyRows !== null &&
    after.historyRows < before.historyRows
  )
    problems.push({ check: "history", before: before.historyRows, after: after.historyRows });
  if (problems.length)
    return Effect.fail(
      refuse(
        "snapshot-compare",
        "data shrank or Home's schema moved",
        "stop; restore from the backup if data was lost",
        {
          problems,
        },
      ),
    );
  return Effect.void;
}

/** The pool database admin URL the stack's own PoolDatabase command was given (never printed). */
export const poolDatabaseUrl = (state: StateService, stack: { name: string; stage: string }) =>
  Effect.gen(function* () {
    const row = yield* state.get({ stack: stack.name, stage: stack.stage, fqn: "PoolDatabase" });
    const env: unknown =
      row &&
      "resourceType" in row &&
      row.resourceType === "Command.Exec" &&
      ["created", "updated"].includes(row.status)
        ? row.props?.env
        : undefined;
    const value =
      env && typeof env === "object" ? Reflect.get(env, "POOL_DATABASE_ADMIN_URL") : undefined;
    const text = Redacted.isRedacted(value) ? Redacted.value(value) : value;
    if (typeof text !== "string" || !text)
      return yield* refuse(
        "database-authority",
        "the PoolDatabase row has no settled admin URL",
        "deploy the stage once, or check its State row",
        {
          status: row && "status" in row ? row.status : "missing",
        },
      );
    return Redacted.make(clientConfig(text, "pool").connectionString);
  });

/** A short-lived pg session for `readSnapshot`. */
export const connect = (url: Redacted.Redacted<string>) =>
  Effect.acquireRelease(
    Effect.tryPromise({
      try: async () => {
        const client = new pg.Client({
          connectionString: Redacted.value(url),
          connectionTimeoutMillis: 5_000,
        });
        client.on("error", () => {});
        await client.connect();
        return client;
      },
      catch: (cause) =>
        refuse("database-connect", "could not connect read-only", "rerun", {
          cause: String(cause),
        }),
    }),
    (client) => Effect.promise(() => client.end().catch(() => {})),
  ).pipe(
    Effect.map((client): Session => ({ query: (text, values) => client.query(text, values) })),
  );

const Backup = Schema.Struct({ id: Schema.String, name: Schema.String, state: Schema.String });

/** A PlanetScale backup of the pool's branch, created and waited to completion before anything applies. */
export const takeBackup = (input: {
  organization: string;
  tokenId: Redacted.Redacted<string>;
  token: Redacted.Redacted<string>;
  database: string;
  branch: string;
  name: string;
  apiOrigin?: string;
  timeout?: Duration.Input;
  pollEvery?: Duration.Input;
}) =>
  Effect.gen(function* () {
    if (input.name.length > 64)
      return yield* refuse("backup-name", "PlanetScale rejects long names", "shorten it", {
        length: input.name.length,
      });
    const client = (yield* HttpClient.HttpClient).pipe(HttpClient.filterStatusOk);
    const base = `${input.apiOrigin ?? "https://api.planetscale.com/v1"}/organizations/${encodeURIComponent(input.organization)}/databases/${encodeURIComponent(input.database)}/branches/${encodeURIComponent(input.branch)}/backups`;
    const auth = HttpClientRequest.setHeader(
      "authorization",
      `${Redacted.value(input.tokenId)}:${Redacted.value(input.token)}`,
    );
    const read = (request: HttpClientRequest.HttpClientRequest) =>
      client.execute(auth(request)).pipe(
        Effect.flatMap((response) => response.json),
        Effect.map((body) => Schema.decodeUnknownSync(Backup)(body)),
      );
    const created = yield* read(
      HttpClientRequest.post(base).pipe(
        HttpClientRequest.bodyJsonUnsafe({
          name: input.name,
          emergency: false,
          retention_value: 30,
          retention_unit: "day",
        }),
      ),
    );
    const done = yield* read(
      HttpClientRequest.get(`${base}/${encodeURIComponent(created.id)}`),
    ).pipe(
      Effect.flatMap((backup) =>
        backup.state === "success"
          ? Effect.succeed(backup)
          : ["failed", "canceled", "cancelled", "error"].includes(backup.state)
            ? Effect.die(
                refuse(
                  "backup-failed",
                  "PlanetScale reports the backup failed",
                  "do not deploy; investigate the backup",
                  { state: backup.state, id: backup.id },
                ),
              )
            : Effect.fail("pending" as const),
      ),
      Effect.retry({
        while: (error) => error === "pending",
        schedule: Schedule.spaced(input.pollEvery ?? "10 seconds"),
      }),
      Effect.timeoutOrElse({
        duration: input.timeout ?? "25 minutes",
        orElse: () =>
          Effect.fail(
            refuse(
              "backup-timeout",
              "the backup did not complete in time",
              "do not deploy; rerun the backup step",
            ),
          ),
      }),
    );
    if (done.name !== input.name)
      return yield* refuse(
        "backup-identity",
        "PlanetScale returned a different backup",
        "do not deploy",
        { expected: input.name, got: done.name },
      );
    return { id: done.id, name: done.name };
  }).pipe(
    Effect.catchDefect((defect) =>
      defect instanceof DatabaseSafetyRefusal ? Effect.fail(defect) : Effect.die(defect),
    ),
    Effect.mapError((error) =>
      error instanceof DatabaseSafetyRefusal
        ? error
        : new DatabaseSafetyRefusal({
            check: "backup-request",
            why: "a PlanetScale request failed",
            fix: "rerun the backup step",
            cause: error,
          }),
    ),
  );

// PlanetScale branch metrics (the same series the history import guards on); points are [unix s, %].
const Metrics = Schema.Struct({
  series: Schema.Array(
    Schema.Struct({
      metric: Schema.String,
      points: Schema.Array(Schema.Tuple([Schema.Number, Schema.Number])),
    }),
  ),
});
export const cpuMetric = "planetscale_primary_pods_cpu_util_percentages";

/**
 * Refuses unless the primary's latest CPU reading is fresh and under `ceiling` percent, so a release
 * never starts against a pegged database. An unreadable or stale series refuses too.
 */
export const assertPrimaryCpuBelow = (input: {
  organization: string;
  tokenId: Redacted.Redacted<string>;
  token: Redacted.Redacted<string>;
  database: string;
  branch: string;
  ceiling: number;
  now: number;
  apiOrigin?: string;
}) =>
  Effect.gen(function* () {
    const client = (yield* HttpClient.HttpClient).pipe(HttpClient.filterStatusOk);
    const query = new URLSearchParams({ period: "15m", steps: "15" });
    query.append("metrics", cpuMetric);
    const url = `${input.apiOrigin ?? "https://api.planetscale.com/v1"}/organizations/${encodeURIComponent(input.organization)}/databases/${encodeURIComponent(input.database)}/branches/${encodeURIComponent(input.branch)}/metrics?${query}`;
    const body = yield* client
      .execute(
        HttpClientRequest.get(url).pipe(
          HttpClientRequest.setHeader(
            "authorization",
            `${Redacted.value(input.tokenId)}:${Redacted.value(input.token)}`,
          ),
        ),
      )
      .pipe(
        Effect.flatMap((response) => response.json),
        Effect.flatMap(Schema.decodeUnknownEffect(Metrics)),
        Effect.mapError(
          (cause) =>
            new DatabaseSafetyRefusal({
              check: "database-cpu-unreadable",
              why: "The primary's CPU could not be read",
              fix: "Do not release until the database's load can be read",
              cause,
            }),
        ),
      );
    const points = body.series.find((series) => series.metric === cpuMetric)?.points ?? [];
    const latest = [...points].sort((a, b) => a[0] - b[0]).at(-1);
    if (!latest || input.now / 1_000 - latest[0] > 300)
      return yield* refuse(
        "database-cpu-stale",
        "No CPU reading from the last five minutes",
        "Rerun once metrics report",
        {
          latestAt: latest ? new Date(latest[0] * 1_000).toISOString() : null,
        },
      );
    if (latest[1] >= input.ceiling)
      return yield* refuse(
        "database-cpu-high",
        "The pool database's primary is too busy to release against",
        "Wait until it is under the ceiling",
        {
          cpuPercent: Math.round(latest[1] * 10) / 10,
          ceiling: input.ceiling,
          at: new Date(latest[0] * 1_000).toISOString(),
        },
      );
    return { cpuPercent: latest[1], at: new Date(latest[0] * 1_000).toISOString() };
  });
