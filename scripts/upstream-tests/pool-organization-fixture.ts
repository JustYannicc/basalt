import { after } from "node:test";
import { ConfigProvider, Effect, Logger, ManagedRuntime } from "effect";
import { HttpServerRequest } from "effect/http";
import { SqlClient, SqlError } from "effect/sql";
import { pgliteLayer } from "../../.upstream/packages/fumadb-effect/src/pglite.ts";
import { StatementBatch } from "../../.upstream/apps/hosted/server/src/contracts/executor.ts";
import { GroupDatabase } from "../../.upstream/apps/hosted/server/src/contracts/groups.ts";
import { OrganizationTombstones } from "../../.upstream/apps/hosted/server/src/contracts/organization-removal.ts";
import {
  poolOrganizationReadPath,
  readPoolOrganization,
} from "../../.upstream/apps/hosted/server/src/implementation/pool-organization.ts";
import { signEnvelope } from "../../src/pool/token.ts";

export const signingKey = "ab".repeat(32);
export const person = "org_person";
export const pool = "app_person_pool";
export const owned = (organization: string) => `organization:${organization}`;

/** One line the check wrote: its message and its fields. */
export interface Line {
  readonly level: string;
  readonly message: unknown;
  readonly fields: unknown;
}
export interface Answer {
  readonly status: number;
  readonly lines: readonly Line[];
}

// One embedded database per test file; each test starts from empty tables.
const runtime = ManagedRuntime.make(pgliteLayer());
after(() => runtime.dispose());
let ready: Promise<void> | undefined;
const schema = () =>
  (ready ??= runtime.runPromise(
    Effect.gen(function* () {
      const db = yield* SqlClient.SqlClient;
      yield* db`create table organization (id text primary key, metadata text)`;
      yield* db`create table executor_apps (id text primary key, owner text not null, active_deployment text)`;
    }),
  ));

export interface Rows {
  readonly organizations?: Readonly<Record<string, unknown>>;
  readonly apps?: Readonly<Record<string, { owner: string; active?: boolean }>>;
}

/** Replace every row; an organization's value is stored as its metadata JSON, or as given when a string. */
export const seed = async (rows: Rows) => {
  await schema();
  await runtime.runPromise(
    Effect.gen(function* () {
      const db = yield* SqlClient.SqlClient;
      yield* db`delete from organization`;
      yield* db`delete from executor_apps`;
      for (const [id, metadata] of Object.entries(rows.organizations ?? {}))
        yield* db`insert into organization values (${id}, ${
          metadata === null || typeof metadata === "string" ? metadata : JSON.stringify(metadata)
        })`;
      for (const [id, app] of Object.entries(rows.apps ?? {}))
        yield* db`insert into executor_apps values (${id}, ${app.owner}, ${
          app.active === false ? null : `dpl_${id}`
        })`;
    }),
  );
};

export interface Ask {
  readonly organization: string;
  readonly pool?: string;
  readonly at?: number;
  readonly expiresAt?: number;
  readonly key?: string | null;
  readonly tombstoned?: readonly string[];
  /** The database the handler is given, in place of this file's own. */
  readonly database?: (db: SqlClient.SqlClient) => SqlClient.SqlClient;
  /**
   * Whether the handler gets a client that sends one batch as one transaction, as Cloud's grouped
   * event pool does, instead of one that sends each statement on its own.
   */
  readonly batched?: boolean;
}

/** A client that says it leases one connection at a time, as Cloud's grouped event pool does. */
const grouped = (db: SqlClient.SqlClient): SqlClient.SqlClient =>
  new Proxy(db, {
    get(target, key, receiver) {
      if (key !== "config") return Reflect.get(target, key, receiver);
      return { ...Reflect.get(target, key, receiver), multiplex: true, multiplexConcurrency: 1 };
    },
  });

/** The tools service's answer to one signed organization read, and the lines it wrote. */
export const ask = async (input: Ask): Promise<Answer> => {
  await schema();
  const now = Date.now();
  const envelope = await signEnvelope(signingKey, "sbq1", {
    pool: input.pool ?? pool,
    organization: input.organization,
    at: input.at ?? now,
    expiresAt: input.expiresAt ?? now + 30_000,
  });
  return answer(JSON.stringify({ envelope }), input);
};

/** Run the real handler over this file's database for an already encoded request body. */
export const answer = async (
  body: string,
  input: Pick<Ask, "key" | "tombstoned" | "database" | "batched"> = {},
): Promise<Answer> => {
  await schema();
  const lines: Line[] = [];
  const capture = Logger.make((options) => {
    const { message, level } = Logger.formatStructured.log(options);
    const [text, fields] = Array.isArray(message) ? message : [message, undefined];
    lines.push({ level, message: text, fields });
  });
  const key = input.key === undefined ? signingKey : input.key;
  const tombstoned = new Set(input.tombstoned ?? []);
  const response = await runtime.runPromise(
    Effect.gen(function* () {
      const db = yield* SqlClient.SqlClient;
      const given = input.database?.(db) ?? db;
      return yield* readPoolOrganization.pipe(
        // Each leaf keeps its own exit; one that fails aborts the transaction for the ones after it.
        Effect.provideService(
          StatementBatch,
          input.batched
            ? (leaves) => db.withTransaction(Effect.forEach(leaves, (leaf) => Effect.exit(leaf)))
            : undefined,
        ),
        Effect.provideService(
          HttpServerRequest.HttpServerRequest,
          HttpServerRequest.fromWeb(
            new Request(`https://tools${poolOrganizationReadPath}`, {
              method: "POST",
              headers: { "content-type": "application/json" },
              body,
            }),
          ),
        ),
        Effect.provideService(
          GroupDatabase,
          Effect.succeed(input.batched ? grouped(given) : given),
        ),
        Effect.provideService(OrganizationTombstones, (organization: string) =>
          Effect.succeed(tombstoned.has(organization)),
        ),
        Effect.provideService(
          ConfigProvider.ConfigProvider,
          ConfigProvider.fromEnv({ env: key === null ? {} : { POOL_APP_SIGNING_KEY: key } }),
        ),
        Effect.provide(Logger.layer([capture])),
      );
    }),
  );
  return { status: response.status, lines };
};

/** The one line a refusal writes: ids and the shape, never metadata. */
export const refused = (organization: string, shape: string, target = pool) => ({
  level: "WARN",
  message: "Pool organization refused",
  fields: { pool: target, organization, shape },
});

/** The line metadata the rule cannot read writes: the check answers unavailable, never refused. */
export const wouldRefuse = (organization: string, shape: string, target = pool) => ({
  level: "WARN",
  message: "Pool organization would be refused",
  fields: { pool: target, organization, shape },
});

/** The line a failed or unexplained ownership read writes beside its unavailable answer. */
export const notObserved = (organization: string, reason: string, target = pool) => ({
  level: "WARN",
  message: "Pool organization ownership not observed",
  fields: { pool: target, organization, reason },
});

/** How the driver reports a read the database ended at its statement timeout. */
export const endedByDatabase = () =>
  new SqlError.SqlError({
    reason: new SqlError.StatementTimeoutError({ cause: new Error("canceling statement") }),
  });

/**
 * This file's database, except that the ownership rule's read (the one that walks an
 * organization's pool records) answers with `read` instead, for `organization` only when given.
 * Every other query is the real one.
 */
export const ownershipReadAnswers =
  <A, E>(read: Effect.Effect<A, E>, organization?: string) =>
  (db: SqlClient.SqlClient): SqlClient.SqlClient =>
    new Proxy(db, {
      apply(target, self, args: [TemplateStringsArray, ...unknown[]]) {
        const rule = args[0].join("").includes("jsonb_each");
        const named = organization === undefined || args.slice(1).includes(organization);
        return rule && named ? read : Reflect.apply(target, self, args);
      },
    });
