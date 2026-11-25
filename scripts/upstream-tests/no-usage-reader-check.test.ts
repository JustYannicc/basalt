import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { Crypto, Effect, Option, Redacted } from "effect";
import { SqlClient, type SqlError } from "effect/sql";
import { providerDeclaration } from "../../.upstream/packages/apps/src/host.ts";
import { pgliteLayer } from "../../.upstream/packages/fumadb-effect/src/pglite.ts";
import {
  AccountId,
  OwnerId,
  ProviderId,
  identifyProvider,
} from "../../.upstream/packages/sdk/src/core.ts";
import {
  AccountAcquisitionUnavailable,
  type AccountAcquisitionBinding,
} from "../../.upstream/packages/sdk/src/contracts/account-acquisition-driver.ts";
import type { AccountHealth } from "../../.upstream/packages/apps/src/contracts/account-health.ts";
import { StorageError } from "../../.upstream/packages/sdk/src/contracts/shared.ts";
import { storedAccount } from "../../.upstream/packages/sdk/src/implementation/accounts.ts";
import { makeDriverAccountHealth } from "../../.upstream/packages/sdk/src/implementation/account-driver-health.ts";
import { database } from "../../.upstream/packages/sdk/src/implementation/database.ts";
import { makeExecutorStorage } from "../../.upstream/packages/sdk/src/implementation/storage.ts";
import { poolAccountAcquisition } from "../../.upstream/apps/hosted/server/src/implementation/pool-account-acquisition.ts";
import { makeAccountRecheckQueue } from "../../.upstream/apps/hosted/server/src/implementation/account-recheck-queue.ts";
import { migrateAccountRechecks } from "../../.upstream/apps/hosted/server/src/implementation/account-recheck-schema.ts";
import { makeAccountRechecks } from "../../.upstream/apps/hosted/server/src/implementation/account-rechecks.ts";
import {
  accountAcquisitionPath,
  accountAcquisitionPrefix,
} from "../../src/pool/account-acquisition-contract.ts";
import { nativeAccountHealth } from "../../src/pool/account-health.ts";
import { signEnvelope } from "../../src/pool/token.ts";
import { HomeClient } from "../../src/pool/control.ts";
import { QuotaCollection } from "../../src/pool/quota-collection.ts";
import { providers } from "../../src/pool/provider-accounts/definitions.ts";
import { availableProviderCapabilities } from "../../src/pool/provider-accounts/capabilities.ts";

const signingKey = "ab".repeat(32);
const crypto = Crypto.make({
  randomBytes: (size) => new Uint8Array(size),
  digest: (_algorithm, data) =>
    Effect.succeed(new Uint8Array(createHash("sha256").update(data).digest())),
});
const registrations = () =>
  Effect.runPromise(
    poolAccountAcquisition(Option.some(Redacted.make(signingKey)), "https://pool.example").pipe(
      Effect.provideService(Crypto.Crypto, crypto),
    ),
  );
const identity = (lab: keyof typeof providers) =>
  Effect.runPromise(
    providerDeclaration(providers[lab]).pipe(
      Effect.flatMap((definition) => identifyProvider(definition, crypto)),
    ),
  );
/** A synthetic failure of the SDK's record of no check. */
type RecheckExecutor = Parameters<typeof makeAccountRechecks>[1];
/** What the runner reads of an account's health: its driver part alone. */
const healthOf = (driver: AccountHealth["driver"]): AccountHealth => ({
  account,
  info: null,
  infoCheckedAt: null,
  apps: [],
  ...(driver === undefined ? {} : { driver }),
});
const subscriptions = availableProviderCapabilities.filter(
  (capability) => capability.connection === "home-oauth",
);

test("a subscription without a usage reader has no check; one with a reader keeps its check", async () => {
  const { registrations: registered } = await registrations();
  const withoutReader: string[] = [];
  for (const capability of subscriptions) {
    const { identity: provider } = await identity(capability.lab as keyof typeof providers);
    const registration = registered.find(
      (entry) => entry.provider === provider && entry.method === capability.method,
    );
    assert.ok(registration, capability.method);
    assert.equal(
      registration.driver.check !== undefined,
      capability.quota === "home",
      capability.method,
    );
    if (registration.driver.check === undefined) withoutReader.push(capability.backend!);
  }
  assert.deepEqual(withoutReader.sort(), ["devin", "gemini-cli", "kimi-ai"]);
});

test("a provider with a usage reader keeps its check, and the pool answers unavailable when its read really fails", async () => {
  const { registrations: registered } = await registrations();
  const { identity: provider } = await identity("anthropic");
  const registration = registered.find(
    (entry) => entry.provider === provider && entry.method === "claude",
  );
  assert.ok(registration?.driver.check);
  const now = Date.now();
  const client = new HomeClient(async (path) => {
    if (path.endsWith("/credentials"))
      return Response.json({ files: [{ id: "bound-id", provider: "claude" }] });
    assert.ok(path.endsWith("/quota/credentials/bound-id"), path);
    return Response.json({
      credential: { credential_id: "bound-id" },
      collection: {
        status: "failed",
        freshness: "fresh",
        observed_at: new Date(now).toISOString(),
        last_attempt_at: new Date(now).toISOString(),
        error: { code: "UPSTREAM_UNAVAILABLE", message: "synthetic" },
      },
      windows: [],
    });
  });
  const storage = new Map<string, unknown>();
  const collection = new QuotaCollection(
    {
      get: async <T>(name: string) => storage.get(name) as T | undefined,
      put: async (name, value) => {
        storage.set(name, value);
      },
    },
    client,
  );
  // The registry's check posts exactly this signed request to the pool; its answer is what the
  // host records. Calling the driver itself would hold its contract's untyped error.
  const envelope = await signEnvelope(signingKey, accountAcquisitionPrefix, {
    owner: "organization:fixture",
    operation: "fixture-check",
    action: "check",
    provider: "claude",
    reference: "bound-id",
    at: now,
    expiresAt: now + 30_000,
  });
  const response = await nativeAccountHealth(
    new Request(`https://pool.example${accountAcquisitionPath}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ envelope }),
    }),
    { client, collection, signingKey },
  );
  assert.equal((await response!.json()).failure, "unavailable");
});

const owner = OwnerId.make("organization:team-a");
const account = AccountId.make("acc_subscription");
const bindingOf = (provider: string, method: string): AccountAcquisitionBinding => ({
  account,
  owner,
  provider: ProviderId.make(provider),
  method,
  driver: "basalt-home",
  driverRevision: "oauth-v1",
  generation: 1,
  revision: "fixture-r1",
  removal: null,
});
const stored = (provider: string, method: string) => ({
  id: account,
  owner,
  provider: ProviderId.make(provider),
  method,
  credentialGeneration: 1,
});

/**
 * A subscription whose earlier check recorded "Service unavailable" seven hours ago, unless
 * `storedRow` is false (an account never checked yet). `withCheck` is whether its registration
 * defines a check: false as the pool registry now builds Devin's, true as for a provider with a reader.
 */
const seeded = (
  provider: string,
  method: string,
  {
    withCheck = false,
    storedRow = true,
  }: { withCheck?: boolean | "unresolved"; storedRow?: boolean } = {},
) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const storage = yield* makeExecutorStorage({ provider: "postgresql" });
    yield* storage.migrate;
    for (const ddl of [
      "create table organization (id text primary key)",
      'create table member (id text primary key, "organizationId" text, "userId" text, role text)',
      "create table hosted_account_access (account_id text, organization_id text, kind text, personal_user_id text)",
      "create table hosted_organization_removal (organization_id text)",
      "create table hosted_app_account_links (app text, account text, subject text, requirement text)",
    ])
      yield* sql.unsafe(ddl);
    yield* migrateAccountRechecks;
    yield* sql`insert into organization values ('team-a')`;
    yield* sql`insert into executor_providers (id, definition) values (${provider}, '{}')`;
    yield* sql`insert into executor_accounts (id, owner, provider, method, label, encrypted_credentials, created_at, credential_generation)
      values (${account}, ${owner}, ${provider}, ${method}, 'Subscription', ${new Uint8Array([1])}, now(), 1)`;
    yield* sql`insert into hosted_account_access values (${account}, 'team-a', 'shared', null)`;
    yield* sql`insert into executor_account_acquisitions
      (account, owner, provider, method, driver, driver_revision, generation, revision, removal)
      values (${account}, ${owner}, ${provider}, ${method}, 'basalt-home', 'oauth-v1', 1, 'fixture-r1', null)`;
    if (storedRow)
      yield* sql`insert into executor_account_driver_checks
      (account, owner, driver, driver_revision, binding_revision, generation, checkable, status, reason, checked_at)
      values (${account}, ${owner}, 'basalt-home', 'oauth-v1', 'fixture-r1', 1, true,
        'upstream_unavailable', 'unavailable', now() - interval '7 hours')`;
    const db = database(storage);
    const binding = bindingOf(provider, method);
    const health = makeDriverAccountHealth(
      db,
      {
        binding: () => Effect.succeed(binding),
        checkable: () =>
          withCheck === "unresolved"
            ? Effect.fail(new AccountAcquisitionUnavailable({ reason: "registration" }))
            : Effect.succeed(withCheck),
        source: () =>
          Effect.succeed({
            binding,
            source: { kind: "driver" as const, id: "basalt-home", version: "oauth-v1" },
            current: Effect.succeed(binding),
          }),
      },
      { status: () => "check_failed", message: () => undefined },
    );
    return { sql, health, saved: yield* storedAccount(db, account, owner) };
  });
const run = <A, E>(work: Effect.Effect<A, E, SqlClient.SqlClient>) =>
  Effect.runPromise(Effect.scoped(work).pipe(Effect.provide(pgliteLayer())));

test("a stored Service unavailable result of a subscription without a check reads as no check", async () => {
  const { identity: provider } = await identity("devin");
  const driver = await run(
    Effect.gen(function* () {
      const { health } = yield* seeded(provider, "devin");
      return (yield* health.report(stored(provider, "devin")))?.driver;
    }),
  );
  // With no result and nothing able to check it, the account list's Health cell stays empty.
  assert.deepEqual(
    { checkable: driver?.checkable, check: driver?.check },
    { checkable: false, check: null },
  );
});

test("a stored failure of a provider with a usage reader still reads unavailable", async () => {
  const { identity: provider } = await identity("anthropic");
  const driver = await run(
    Effect.gen(function* () {
      const { health } = yield* seeded(provider, "claude", { withCheck: true });
      return (yield* health.report(stored(provider, "claude")))?.driver;
    }),
  );
  assert.equal(driver?.checkable, true);
  assert.equal(driver?.check?.status, "upstream_unavailable");
});

test("a stored failure stays visible while its registration cannot be resolved", async () => {
  const { identity: provider } = await identity("anthropic");
  const driver = await run(
    Effect.gen(function* () {
      const { health } = yield* seeded(provider, "claude", { withCheck: "unresolved" });
      return (yield* health.report(stored(provider, "claude")))?.driver;
    }),
  );
  // Only a registration known to define no check hides a result; an outage of it hides nothing.
  assert.equal(driver?.checkable, false);
  assert.equal(driver?.check?.status, "upstream_unavailable");
});

for (const storedRow of [true, false])
  test(`the recheck runner records no check once, and the account leaves the recheck queue (${storedRow ? "stored failure" : "never checked"})`, async () => {
    const { identity: provider } = await identity("devin");
    const result = await run(
      Effect.gen(function* () {
        const { sql, health, saved: accountRow } = yield* seeded(provider, "devin", { storedRow });
        const queue = makeAccountRecheckQueue(sql);
        const checks: string[] = [];
        const executor: RecheckExecutor = {
          accounts: {
            health: () =>
              health
                .report(stored(provider, "devin"))
                .pipe(Effect.map((saved) => healthOf(saved?.driver))),
            check: (input) =>
              Effect.gen(function* () {
                checks.push(input.account);
                yield* health.check(accountRow);
                const saved = yield* health.report(stored(provider, "devin"));
                return healthOf(saved?.driver);
              }),
          },
        };
        // A stored failure past six hours, or an account never checked, is claimed today.
        const before = (yield* queue.claim("probe")).map((entry) => entry.account);
        yield* sql`delete from hosted_account_rechecks`;
        yield* sql`delete from hosted_account_recheck_families`;
        yield* makeAccountRechecks(sql, executor)("run-1");
        const [row] = yield* sql<{
          checkable: boolean;
          status: string | null;
        }>`select checkable, status from executor_account_driver_checks where account = ${account}`;
        const [lease] = yield* sql<{
          outcome: string;
          waits: number;
        }>`select outcome, extract(epoch from next_at - finished_at)::int as waits
        from hosted_account_rechecks where account_id = ${account}`;
        yield* sql`update hosted_account_rechecks set next_at = now() - interval '1 second'`;
        yield* sql`update hosted_account_recheck_families set next_at = now() - interval '1 second'`;
        yield* sql`update executor_account_driver_checks set checked_at = now() - interval '7 hours'`;
        const again = yield* queue.claim("run-2");
        return { before, checks, row, lease, again: again.map((entry) => entry.account) };
      }),
    );
    assert.deepEqual(result.before, [account]);
    assert.deepEqual(
      result.checks,
      [account],
      "the runner asked the SDK to record the account once",
    );
    assert.deepEqual(result.row, { checkable: false, status: null });
    assert.equal(result.lease?.outcome, "skipped");
    assert.ok(result.lease!.waits < 15 * 60, "no 15-minute retry is scheduled");
    assert.deepEqual(result.again, [], "past the six-hour mark, the account is not claimed again");
  });

/** One runner pass over the seeded Devin account; `onHealth` runs between the queue's claim and its start. */
const runnerPass = (
  provider: string,
  options: {
    readonly onHealth?: Effect.Effect<void, SqlError.SqlError, SqlClient.SqlClient>;
    readonly failRecord?: boolean;
  },
) =>
  Effect.gen(function* () {
    const { sql, health } = yield* seeded(provider, "devin");
    const records: string[] = [];
    const executor: RecheckExecutor = {
      accounts: {
        health: () =>
          Effect.gen(function* () {
            if (options.onHealth)
              yield* options.onHealth.pipe(
                Effect.provideService(SqlClient.SqlClient, sql),
                Effect.mapError(() => new StorageError()),
              );
            const saved = yield* health.report(stored(provider, "devin"));
            return healthOf(saved?.driver);
          }),
        check: (input) =>
          Effect.gen(function* () {
            records.push(input.account);
            if (options.failRecord) return yield* new StorageError();
            return healthOf(undefined);
          }),
      },
    };
    yield* makeAccountRechecks(sql, executor)("run-1");
    const [lease] = yield* sql<{
      outcome: string;
      waits: number;
    }>`select outcome, extract(epoch from next_at - finished_at)::int as waits
      from hosted_account_rechecks where account_id = ${account}`;
    return { records, lease };
  });

test("the runner records no check only while it holds the account's lease and provider family", async () => {
  const { identity: provider } = await identity("devin");
  const result = await run(
    runnerPass(provider, {
      // Another account of the same provider family takes the family before this pass starts.
      onHealth: Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql`insert into hosted_account_recheck_families values
          (${provider}, now() + interval '1 hour', 'acc_other', 'other-run')
          on conflict (provider_key) do update set next_at = excluded.next_at,
            account_id = excluded.account_id, lease = excluded.lease`;
      }),
    }),
  );
  assert.deepEqual(result.records, []);
  assert.equal(result.lease?.outcome, "skipped");
  assert.equal(result.lease?.waits, 15 * 60);
});

test("a record of no check that fails, or reports no driver, is tried again in 15 minutes", async () => {
  const { identity: provider } = await identity("devin");
  for (const failRecord of [true, false]) {
    const result = await run(runnerPass(provider, { failRecord }));
    assert.deepEqual(result.records, [account]);
    assert.equal(result.lease?.outcome, "skipped");
    assert.equal(result.lease?.waits, 15 * 60, `failRecord ${failRecord}`);
  }
});
