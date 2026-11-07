import { createHash } from "node:crypto";
import { Crypto, Effect } from "effect";
import { SqlClient } from "effect/sql";
import { CurrentTransformer } from "effect/sql/Statement";
import { pgliteLayer } from "../../.upstream/packages/fumadb-effect/src/pglite.ts";
import { sdk } from "./provider-destinations-modules.ts";
import type {
  AccountId,
  Executor,
  MachineAccounts,
  OwnerId,
} from "../../.upstream/packages/sdk/src/core.ts";

const { accountIdentityPlacements } = (await import(
  new URL(
    "../../.upstream/apps/hosted/server/src/implementation/account-identity-placement.ts",
    import.meta.url,
  ).href
)) as typeof import("../../.upstream/apps/hosted/server/src/implementation/account-identity-placement.ts");

/** Count executed SQL, since the public SDK wraps account reads with target and identity reads. */
export const counted = <A, E, R>(work: Effect.Effect<A, E, R>) =>
  Effect.suspend(() => {
    const statements: string[] = [];
    return work.pipe(
      Effect.provideService(CurrentTransformer, (statement) =>
        Effect.sync(() => {
          statements.push(statement.compile()[0]);
          return statement;
        }),
      ),
      Effect.map((value) => ({ value, statements })),
    );
  });

const unused = () => Effect.die("Account read reached an unrelated host capability");
const crypto = Crypto.make({
  randomBytes: (size) => new Uint8Array(size),
  digest: (_algorithm, data) =>
    Effect.succeed(new Uint8Array(createHash("sha256").update(data).digest())),
});

/** Use the normal SDK constructor and real storage; unrelated app execution refuses use. */
export const sdkFixture = <A, E, R>(
  run: (input: {
    executor: Executor;
    sql: SqlClient.SqlClient;
    owner: OwnerId;
    ids: AccountId[];
    foreign: AccountId;
  }) => Effect.Effect<A, E, R>,
  saved = 48,
  machineAccounts?: MachineAccounts,
) =>
  Effect.scoped(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const database = yield* sdk.makeExecutorStorage({ provider: "postgresql" });
      yield* database.migrate;
      yield* sql`create table hosted_account_access (account_id text primary key,
        organization_id text, kind text, personal_user_id text, audience text)`;
      yield* sql`create table hosted_account_groups (account_id text, group_id text)`;
      const owner = sdk.OwnerId.make("organization:linked-sdk");
      const foreign = sdk.AccountId.make("acc_foreign");
      const ids = Array.from({ length: saved }, (_, i) =>
        sdk.AccountId.make(`acc_${String(i).padStart(3, "0")}`),
      );
      yield* sql`insert into executor_providers (id, definition)
        values ('prv_linked', ${JSON.stringify({ name: "Linked", auth: {} })}),
        ('prv_other', ${JSON.stringify({ name: "Other", auth: {} })})`;
      for (const id of [...ids, foreign]) {
        const accountOwner = id === foreign ? "organization:foreign" : owner;
        const organization = id === foreign ? "foreign" : "linked-sdk";
        const placement = JSON.stringify([organization, "shared", null, "everyone", []]);
        yield* sql`insert into executor_accounts
          (id, owner, provider, method, label, encrypted_credentials, created_at, identity_id)
          values (${id}, ${accountOwner}, 'prv_linked', 'key', ${id}, ${new Uint8Array([1])}, now(), ${`aid_${id}`})`;
        yield* sql`insert into hosted_account_access values (${id}, ${organization}, 'shared', null, 'everyone')`;
        yield* sql`insert into executor_account_identities
          (id, owner, placement, issuer, subject, name, label, verified_at, created_at)
          values (${`aid_${id}`}, ${accountOwner}, ${placement}, 'https://identity.invalid',
            ${id}, ${id}, ${id}, now(), now())`;
      }
      const placements = accountIdentityPlacements(sql);
      const executor = yield* sdk.createExecutor({
        database,
        credentials: { encrypt: unused, decrypt: unused, fingerprint: unused },
        git: {
          history: unused,
          create: unused,
          head: unused,
          read: unused,
          commit: unused,
          blob: unused,
          file: unused,
          request: unused,
        },
        blobs: {
          get: unused,
          exists: unused,
          put: unused,
          remove: unused,
          list: unused,
          stream: unused,
        },
        runtime: sdk.runtimeAdapter({
          build: unused,
          skills: unused,
          inspect: unused,
          index: unused,
          query: unused,
          mutate: unused,
          webhook: unused,
          workflow: unused,
          mcpApp: unused,
          call: unused,
          connect: unused,
          checkAccount: unused,
          migrate: unused,
        }),
        hooks: {
          accountIdentityPlacements: placements,
          accountIdentityPlacement: (account) =>
            placements([account]).pipe(Effect.map((found) => found.get(account.id) ?? null)),
          userLinks: unused,
          appLinks: unused,
          sourceActorLost: unused,
          appResolving: unused,
          removalResolving: unused,
          accountsResolving: unused,
          connectionCompleting: unused,
          appCreated: unused,
          appRemoving: unused,
          appAccountConnected: unused,
          accountCreated: unused,
          accountRemoving: unused,
        },
        ...(machineAccounts === undefined ? {} : { machineAccounts }),
      });
      return yield* run({ executor, sql, owner, ids, foreign });
    }),
  ).pipe(Effect.provide(pgliteLayer()), Effect.provideService(Crypto.Crypto, crypto));
