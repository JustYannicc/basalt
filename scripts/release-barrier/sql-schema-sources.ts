import { Effect, Redacted } from "effect";
import type { StateService } from "alchemy/State/State";
import type { CompiledStack } from "alchemy/Stack";
import pg from "pg";
import { clientConfig } from "../pool-database-provisioning.ts";
import type { SqlJournalSource } from "./sql-schema-read.ts";
import { BarrierRefusal } from "./refusal.ts";

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

/** Consume only the existing migration Commands' in-process authority, never expose a new SQL endpoint. */
export const deploymentSqlSources = (
  state: StateService,
  stack: Pick<CompiledStack, "name" | "stage">,
) =>
  Effect.gen(function* () {
    const commandEnv = (fqn: string) =>
      Effect.gen(function* () {
        const value = yield* state.get({ stack: stack.name, stage: stack.stage, fqn });
        if (
          !value ||
          !("resourceType" in value) ||
          value.resourceType !== "Command.Exec" ||
          (value.status !== "created" && value.status !== "updated")
        )
          throw new BarrierRefusal("sql-schema-authority-unavailable", fqn);
        const env: unknown = value.props?.env;
        if (!env || typeof env !== "object" || Array.isArray(env))
          throw new BarrierRefusal("sql-schema-authority-unavailable", fqn);
        return env;
      });
    const tools = yield* commandEnv("Migrations");
    const pool = yield* commandEnv("PoolDatabase");
    if (!("DATABASE_URL" in tools) || !("POOL_DATABASE_ADMIN_URL" in pool))
      throw new BarrierRefusal("sql-schema-authority-unavailable");
    const toolsUrl = secret(tools.DATABASE_URL);
    const poolUrl = clientConfig(secret(pool.POOL_DATABASE_ADMIN_URL), "pool").connectionString;
    return {
      sources: { tools: source(toolsUrl), pool: source(poolUrl) },
      poolUrl: Redacted.make(poolUrl),
    };
  });
