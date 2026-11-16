import { Effect, Redacted } from "effect";
import type { StateService } from "alchemy/State/State";
import type { CompiledStack } from "alchemy/Stack";
import pg from "pg";
import { clientConfig } from "../pool-database-provisioning.ts";
import type { SqlJournalSource } from "./sql-schema-read.ts";
import { BarrierRefusal } from "./refusal.ts";

const resourceStatuses = [
  "creating",
  "created",
  "updating",
  "updated",
  "deleting",
  "replacing",
  "replaced",
] as const;
type AuthorityStatus = (typeof resourceStatuses)[number] | "missing" | "unknown";
type AuthorityCheck =
  | "resource-missing"
  | "resource-type"
  | "resource-status"
  | "environment"
  | "database-authority"
  | "updating-authority-drift";
export class SqlSchemaAuthorityFailure extends BarrierRefusal {
  readonly authority: {
    resource: "Migrations" | "PoolDatabase";
    check: AuthorityCheck;
    status: AuthorityStatus;
  };
  constructor(
    resource: "Migrations" | "PoolDatabase",
    check: AuthorityCheck,
    status: AuthorityStatus,
  ) {
    super("sql-schema-authority-unavailable", resource);
    this.authority = { resource, check, status };
  }
}
const authorityStatus = (value: unknown): AuthorityStatus => {
  if (value === undefined) return "missing";
  const status =
    typeof value === "object" && value !== null ? Reflect.get(value, "status") : undefined;
  return resourceStatuses.find((allowed) => allowed === status) ?? "unknown";
};

function secret(value: unknown): string {
  const text = Redacted.isRedacted(value) ? Redacted.value(value) : value;
  if (typeof text !== "string" || !text)
    throw new BarrierRefusal("sql-schema-authority-unavailable");
  return text;
}
function source(connectionString: string): SqlJournalSource {
  let databaseName: string;
  try {
    const url = new URL(connectionString);
    if (!["postgres:", "postgresql:"].includes(url.protocol)) throw new Error();
    databaseName = decodeURIComponent(url.pathname.slice(1)) || "postgres";
  } catch {
    throw new BarrierRefusal("sql-schema-authority-unavailable");
  }
  return {
    databaseName,
    connect: async () => {
      const client = new pg.Client({
        connectionString,
        connectionTimeoutMillis: 2_500,
        query_timeout: 5_000,
        keepAlive: true,
      });
      client.on("error", () => {});
      const destroy = () => {
        try {
          client.connection.stream.destroy();
        } catch {
          /* Closing still fails closed. */
        }
      };
      const timer = setTimeout(destroy, 20_000);
      try {
        await client.connect();
      } catch (error) {
        clearTimeout(timer);
        destroy();
        throw error;
      }
      return {
        query: (text, values) => client.query(text, values),
        end: async () => {
          clearTimeout(timer);
          const closing = client.end().catch(() => {});
          let closeTimer: ReturnType<typeof setTimeout> | undefined;
          await Promise.race([
            closing,
            new Promise<void>((resolve) => {
              closeTimer = setTimeout(() => {
                destroy();
                resolve();
              }, 2_000);
            }),
          ]);
          clearTimeout(closeTimer);
        },
      };
    },
  };
}

const commandEnv = (
  state: StateService,
  stack: Pick<CompiledStack, "name" | "stage">,
  fqn: "Migrations" | "PoolDatabase",
  inspectUpdate = false,
) =>
  Effect.gen(function* () {
    const value = yield* state.get({ stack: stack.name, stage: stack.stage, fqn });
    const status = authorityStatus(value);
    if (!value) throw new SqlSchemaAuthorityFailure(fqn, "resource-missing", status);
    if (!("resourceType" in value) || value.resourceType !== "Command.Exec")
      throw new SqlSchemaAuthorityFailure(fqn, "resource-type", status);
    if (
      value.status !== "created" &&
      value.status !== "updated" &&
      !(inspectUpdate && value.status === "updating")
    )
      throw new SqlSchemaAuthorityFailure(fqn, "resource-status", status);
    const env: unknown = value.props?.env;
    if (!env || typeof env !== "object" || Array.isArray(env))
      throw new SqlSchemaAuthorityFailure(fqn, "environment", status);
    // A failed Command remains updating. Inspect only when both recorded authorities agree exactly.
    if (value.status === "updating") {
      const before: unknown = value.old.props.env;
      if (
        !before ||
        typeof before !== "object" ||
        !("DATABASE_URL" in before) ||
        !("DATABASE_URL" in env)
      )
        throw new SqlSchemaAuthorityFailure(fqn, "updating-authority-drift", status);
      let matches = false;
      try {
        matches = secret(before.DATABASE_URL) === secret(env.DATABASE_URL);
      } catch {
        /* Invalid recorded authority cannot establish equality. */
      }
      if (!matches) throw new SqlSchemaAuthorityFailure(fqn, "updating-authority-drift", status);
    }
    return { env, status };
  });

/** Inspection reads only the release's existing tools authority, without initializing State. */
export const inspectionSqlSource = (state: StateService) =>
  Effect.gen(function* () {
    const tools = yield* commandEnv(
      state,
      { name: "basalt", stage: "production" },
      "Migrations",
      true,
    );
    if (!("DATABASE_URL" in tools.env))
      throw new SqlSchemaAuthorityFailure("Migrations", "database-authority", tools.status);
    try {
      return source(secret(tools.env.DATABASE_URL));
    } catch {
      throw new SqlSchemaAuthorityFailure("Migrations", "database-authority", tools.status);
    }
  });

/** Consume only the existing migration Commands' in-process authority, never expose a new SQL endpoint. */
export const deploymentSqlSources = (
  state: StateService,
  stack: Pick<CompiledStack, "name" | "stage">,
) =>
  Effect.gen(function* () {
    const tools = (yield* commandEnv(state, stack, "Migrations")).env;
    const pool = (yield* commandEnv(state, stack, "PoolDatabase")).env;
    if (!("DATABASE_URL" in tools) || !("POOL_DATABASE_ADMIN_URL" in pool))
      throw new BarrierRefusal("sql-schema-authority-unavailable");
    const toolsUrl = secret(tools.DATABASE_URL);
    const poolUrl = clientConfig(secret(pool.POOL_DATABASE_ADMIN_URL), "pool").connectionString;
    return {
      sources: { tools: source(toolsUrl), pool: source(poolUrl) },
      toolsUrl: Redacted.make(toolsUrl),
      poolUrl: Redacted.make(poolUrl),
    };
  });
