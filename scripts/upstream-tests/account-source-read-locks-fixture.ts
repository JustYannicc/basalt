import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { Crypto, Effect, Redacted } from "effect";
import { SqlClient } from "effect/sql";
import { CurrentTransformer } from "effect/sql/Statement";
import * as sdk from "../../.upstream/packages/sdk/src/core.ts";
import { makeExecutorStorage } from "../../.upstream/packages/sdk/src/implementation/storage.ts";
import { database } from "../../.upstream/packages/sdk/src/implementation/database.ts";
import { aesGcmCredentials } from "../../.upstream/packages/sdk/src/implementation/credentials.ts";
import { makeAppConnections } from "../../.upstream/packages/sdk/src/implementation/app-connections.ts";
import { reconcileAccountSources } from "../../.upstream/apps/hosted/server/src/implementation/app-accounts.ts";
import { HostedExecutor } from "../../.upstream/apps/hosted/server/src/contracts/executor.ts";
import { CurrentUserId } from "../../.upstream/apps/hosted/server/src/contracts/auth.ts";
import {
  CurrentOrganization,
  OrganizationId,
} from "../../.upstream/apps/hosted/server/src/contracts/organization.ts";
import { GroupDatabase } from "../../.upstream/apps/hosted/server/src/contracts/groups.ts";
import { blockedOrDone, pid, postgresChanges } from "./account-change-postgres-fixture.ts";

const require = createRequire(
  new URL("../../.upstream/packages/fumadb-effect/package.json", import.meta.url),
);
const PgClient: typeof import("../../.upstream/packages/fumadb-effect/node_modules/@effect/sql-pg/dist/PgClient.js") =
  await import(require.resolve("@effect/sql-pg/PgClient"));

export type SourceState = "selected" | "revoked" | "missing";
type StoredSource = { revision: number | string; enabled: boolean; encrypted: string };
type LockResult = {
  blocked: boolean;
  finishedUnderReadLock: boolean;
  lockStatements: number;
  writes: number;
};
type SourceFixture = {
  setState: (state: SourceState) => Promise<void>;
  readStored: () => Promise<StoredSource[]>;
  reconcile: () => Promise<void>;
  underReadLock: () => Promise<LockResult>;
};

/** Real SDK encrypted bindings and reconciliation; only app metadata is supplied by the fixture. */
export const sourceReadLocks = (work: (fixture: SourceFixture) => Promise<void>) =>
  postgresChanges(async ({ a, b, observer }) => {
    const {
      rows: [{ schema }],
    } = await b.query<{ schema: string }>("select current_schema() as schema");
    const blocker = await pid(a);
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          for (const ddl of [
            "alter table hosted_app_account_links add column created_at timestamptz default now(), add column linked_by text",
            "alter table hosted_app_access add column creator_id text, add column revision text",
            "alter table hosted_account_access add column kind text default 'shared', add column personal_user_id text, add column creator_id text, add column revision text",
          ])
            yield* sql.unsafe(ddl);
          yield* sql`update member set role='admin'`;
          yield* sql`update organization set metadata=${JSON.stringify({ basaltPools: { retained: { app: "app_a" } } })}`;
          yield* sql`insert into hosted_app_account_links (app,account,subject,requirement,linked_by)
          values ('app_a','acc_a','viewer-a','models','viewer-a')`;
          yield* sql`insert into hosted_app_access (id,organization_id,audience,creator_id,revision)
          values ('app_a','team-a','everyone','viewer-a','1')`;
          yield* sql`insert into hosted_account_access (account_id,organization_id,audience)
          values ('acc_a','team-a','everyone')`;
          const appId = sdk.AppId.make("app_a");
          const owner = sdk.OwnerId.make("organization:team-a");
          const account = sdk.AccountId.make("acc_a");
          const declaration = { scope: "user" as const, cardinality: "many" as const, tools: {} };
          // Reconciliation reads these fields; app execution and deployment are outside this seam.
          const app = {
            id: appId,
            owner,
            activeVersion: null,
            requirements: {
              accounts: {
                models: {
                  scope: "user",
                  provider: sdk.ProviderId.make("prv_a"),
                  definition: { auth: {} },
                },
              },
              dependencies: { accountView: declaration },
            },
          } as sdk.App;
          const credentials = yield* aesGcmCredentials(
            Redacted.make("19".repeat(32)),
            globalThis.crypto,
          );
          const crypto = Crypto.make({
            randomBytes: (size) => globalThis.crypto.getRandomValues(new Uint8Array(size)),
            digest: (_algorithm, bytes) =>
              Effect.succeed(new Uint8Array(createHash("sha256").update(bytes).digest())),
          });
          const store = makeAppConnections(
            database(yield* makeExecutorStorage({ provider: "postgresql" })),
            credentials,
            crypto,
          );
          const selection = {
            scope: "user" as const,
            requirement: "models",
            account,
            source: {
              app: appId,
              version: sdk.VersionId.make("dpl_source"),
              scope: "user" as const,
              requirement: "models",
            },
          };
          const seal = (state: SourceState) =>
            store.seal(sdk.AppConnectionId.make("acn_source"), {
              declaration,
              accounts: { app: {}, user: { models: [account] } },
              selections:
                state === "missing"
                  ? []
                  : [{ ...selection, ...(state === "revoked" ? { revoked: true } : {}) }],
            });
          yield* sql`insert into executor_app_connections
          (id,app,owner,dependency,subject,target,authorizer,revision,enabled,encrypted,created_at,updated_at)
          values ('acn_source',${appId},${owner},'accountView','viewer-a',${appId},'viewer-a',1,true,${yield* seal("selected")},now(),now())`;
          // The tested implementation gets the real transaction and sealed SDK binding reader.
          const executor = {
            apps: { get: () => Effect.succeed(app) },
            [sdk.AppCallsHost]: { bindings: store.bindings },
            [sdk.StorageHost]: { transaction: sql.withTransaction },
          } as unknown as sdk.Executor;
          const counts = { lockStatements: 0, writes: 0 };
          const operation = reconcileAccountSources(app).pipe(
            Effect.provideService(HostedExecutor, Effect.succeed(executor)),
            Effect.provideService(CurrentUserId, "viewer-a"),
            Effect.provideService(sdk.CurrentActor, "viewer-a"),
            Effect.provideService(CurrentOrganization, {
              organization: OrganizationId.make("team-a"),
              owner,
              role: "admin",
            }),
            Effect.provideService(GroupDatabase, Effect.succeed(sql)),
            Effect.provideService(CurrentTransformer, (statement) =>
              Effect.sync(() => {
                const text = statement.compile()[0];
                if (/pg_advisory_xact_lock|for\s+(?:no\s+key\s+)?update|for\s+share/i.test(text))
                  counts.lockStatements++;
                if (/^\s*(?:insert|update|delete)\b/i.test(text)) counts.writes++;
                return statement;
              }),
            ),
            Effect.provideService(SqlClient.SqlClient, sql),
          );
          const reconcile = async () => {
            await Effect.runPromise(operation);
          };
          const [{ pid: worker }] = yield* sql<{ pid: number }>`select pg_backend_pid() as pid`;
          yield* Effect.promise(() =>
            work({
              reconcile,
              setState: async (state) => {
                await Effect.runPromise(
                  Effect.gen(function* () {
                    const encrypted = yield* seal(state);
                    yield* sql`update executor_app_connections
                set encrypted=${encrypted}, enabled=${state !== "revoked"}`;
                  }),
                );
              },
              readStored: async () =>
                (
                  await observer.query<StoredSource>(
                    "select revision,enabled,encode(encrypted,'hex') as encrypted from executor_app_connections where id='acn_source'",
                  )
                ).rows,
              underReadLock: async () => {
                counts.lockStatements = counts.writes = 0;
                await a.query("begin");
                await a.query("select id from executor_apps where id='app_a' for share");
                let finished = false;
                const running = reconcile()
                  .then(
                    () => ({ ok: true as const }),
                    (error: unknown) => ({ ok: false as const, error }),
                  )
                  .finally(() => {
                    finished = true;
                  });
                let result: LockResult;
                let outcome: Awaited<typeof running>;
                try {
                  await blockedOrDone(observer, worker, blocker, () => finished);
                  const {
                    rows: [lock],
                  } = await observer.query<{ blocked: boolean }>(
                    `select $2::int=any(pg_blocking_pids(pid)) and query ilike '%for no key update%' as blocked
                  from pg_stat_activity where pid=$1`,
                    [worker, blocker],
                  );
                  assert.ok(lock, "reconciliation connection must remain observable");
                  result = { blocked: lock.blocked, finishedUnderReadLock: finished, ...counts };
                } finally {
                  await a.query("rollback");
                  outcome = await running;
                }
                if (!outcome.ok) throw outcome.error;
                return result;
              },
            }),
          );
        }),
      ).pipe(
        Effect.provide(
          PgClient.layer({
            url: Redacted.make(process.env.POOL_TEST_ADMIN_URL!),
            maxConnections: 1,
            startupParameters: {
              search_path: schema,
              lock_timeout: "10000",
              statement_timeout: "15000",
            },
          }),
        ),
      ),
    );
  });
