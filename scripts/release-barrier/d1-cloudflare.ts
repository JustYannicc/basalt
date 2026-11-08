import * as D1 from "@distilled.cloud/cloudflare/d1";
import * as Retry from "@distilled.cloud/cloudflare/Retry";
import { Effect, Stream, Schema, Option } from "effect";
import { CloudflareEnvironment } from "alchemy/Cloudflare";
import type { Database } from "alchemy/Cloudflare/D1";
import type { D1Target } from "./declared-d1-types.ts";
import { d1Mismatch } from "./declared-d1-types.ts";

export const databaseUuid = Schema.String.check(
  Schema.isPattern(/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u),
);

export const d1Account = Effect.gen(function* () {
  const environment = yield* Effect.serviceOption(CloudflareEnvironment);
  if (Option.isNone(environment))
    throw d1Mismatch(
      "missing-declared-d1-account",
      "release-declarations.json",
      { accountScope: "configured" },
      { accountScope: null },
    );
  return (yield* environment.value).accountId;
});

/** Uses the release's existing SDK credential; only an account-scoped metadata GET is permitted. */
export const preflightDeclaredD1 = (accountId: string) =>
  D1.listDatabases({ accountId, perPage: 1 }).pipe(
    Retry.none,
    Effect.asVoid,
    Effect.timeout("15 seconds"),
  );

export const declaredD1Exists = (target: D1Target) =>
  D1.listDatabases.items({ accountId: target.accountId, name: target.databaseName }).pipe(
    Stream.filter((row) => row.name === target.databaseName),
    Stream.runHead,
    Effect.map((value) => value._tag === "Some"),
    Retry.none,
    Effect.timeout("15 seconds"),
  );

/** A UUID is authority only when returned by this single admitted create request. */
export const createDeclaredD1 = (target: D1Target) =>
  D1.createDatabase({
    accountId: target.accountId,
    name: target.databaseName,
    jurisdiction: target.jurisdiction,
  }).pipe(
    Retry.none,
    Effect.map((row) => Schema.decodeUnknownSync(databaseUuid)(row.uuid)),
    Effect.timeout("15 seconds"),
  );

export const readDeclaredD1 = (target: D1Target, databaseId: string, fqn = "declared-d1") =>
  D1.getDatabase({ accountId: target.accountId, databaseId }).pipe(
    Retry.none,
    Effect.map((row) => {
      if (
        row.uuid !== databaseId ||
        row.name !== target.databaseName ||
        row.jurisdiction !== "eu" ||
        (row.readReplication != null && row.readReplication.mode !== "disabled")
      )
        throw d1Mismatch(
          "declared-d1-observation-mismatch",
          fqn,
          {
            databaseId,
            name: target.databaseName,
            jurisdiction: "eu",
            readReplication: "disabled",
          },
          {
            databaseId: row.uuid,
            name: row.name,
            jurisdiction: row.jurisdiction,
            readReplication: row.readReplication?.mode ?? "disabled",
          },
        );
      return {
        ...target,
        databaseId,
        readReplication: undefined,
        migrationsDir: undefined,
        migrationsTable: undefined,
        migrationsHashes: {},
        importHashes: {},
      } satisfies Database["Attributes"];
    }),
    Effect.catchTag("DatabaseNotFound", () => Effect.succeed(undefined)),
    Effect.timeout("15 seconds"),
  );
