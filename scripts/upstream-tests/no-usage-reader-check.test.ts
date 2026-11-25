import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { Crypto, Effect, Option, Redacted } from "effect";
import { SqlClient } from "effect/sql";
import { ProviderError } from "../../.upstream/packages/apps/src/contracts/host.ts";
import { providerDeclaration } from "../../.upstream/packages/apps/src/host.ts";
import { pgliteLayer } from "../../.upstream/packages/fumadb-effect/src/pglite.ts";
import {
  AccountId,
  OwnerId,
  ProviderId,
  identifyProvider,
} from "../../.upstream/packages/sdk/src/core.ts";
import type { AccountAcquisitionBinding } from "../../.upstream/packages/sdk/src/contracts/account-acquisition-driver.ts";
import { makeDriverAccountHealth } from "../../.upstream/packages/sdk/src/implementation/account-driver-health.ts";
import { database } from "../../.upstream/packages/sdk/src/implementation/database.ts";
import { makeExecutorStorage } from "../../.upstream/packages/sdk/src/implementation/storage.ts";
import { poolAccountAcquisition } from "../../.upstream/apps/hosted/server/src/implementation/pool-account-acquisition.ts";
import { makeAccountRecheckQueue } from "../../.upstream/apps/hosted/server/src/implementation/account-recheck-queue.ts";
import { migrateAccountRechecks } from "../../.upstream/apps/hosted/server/src/implementation/account-recheck-schema.ts";
import { makeAccountRechecks } from "../../.upstream/apps/hosted/server/src/implementation/account-rechecks.ts";
import { nativeAccountHealth } from "../../src/pool/account-health.ts";
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

test("a provider with a usage reader still reads unavailable when its read really fails", async () => {
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
  const binding: AccountAcquisitionBinding = {
    account: AccountId.make("acc_claude"),
    owner: OwnerId.make("organization:fixture"),
    provider: ProviderId.make(provider),
    method: "claude",
    driver: "basalt-home",
    driverRevision: "oauth-v1",
    generation: 1,
    revision: "fixture-r1",
    removal: null,
  };
  const failure = await Effect.runPromise(
    registration.driver
      .check({
        owner: binding.owner,
        provider: binding.provider,
        method: "claude",
        operation: "fixture-check",
        deadline: now + 30_000,
        signal: new AbortController().signal,
        fetch: async (input, init) =>
          (await nativeAccountHealth(new Request(input, init), {
            client,
            collection,
            signingKey,
          }))!,
        binding,
        reference: Redacted.make("bound-id"),
      })
      .pipe(Effect.flip),
  );
  const reason =
    failure instanceof ProviderError
      ? failure.reason
      : (failure as { evidence?: { reason?: string } }).evidence?.reason;
  assert.equal(reason, "unavailable");
});

const owner = OwnerId.make("organization:team-a");
const account = AccountId.make("acc_devin");
const devinBinding = (provider: string): AccountAcquisitionBinding => ({
  account,
  owner,
  provider: ProviderId.make(provider),
  method: "devin",
  driver: "basalt-home",
  driverRevision: "oauth-v1",
  generation: 1,
  revision: "fixture-r1",
  removal: null,
});
const stored = (provider: string) => ({
  id: account,
  owner,
  provider: ProviderId.make(provider),
  method: "devin",
  credentialGeneration: 1,
});

/** A Devin account whose earlier check recorded "Service unavailable" seven hours ago. */
const seeded = (provider: string) =>
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
      values (${account}, ${owner}, ${provider}, 'devin', 'Devin', ${new Uint8Array([1])}, now(), 1)`;
    yield* sql`insert into hosted_account_access values (${account}, 'team-a', 'shared', null)`;
    yield* sql`insert into executor_account_acquisitions
      (account, owner, provider, method, driver, driver_revision, generation, revision, removal)
      values (${account}, ${owner}, ${provider}, 'devin', 'basalt-home', 'oauth-v1', 1, 'fixture-r1', null)`;
    yield* sql`insert into executor_account_driver_checks
      (account, owner, driver, driver_revision, binding_revision, generation, checkable, status, reason, checked_at)
      values (${account}, ${owner}, 'basalt-home', 'oauth-v1', 'fixture-r1', 1, true,
        'upstream_unavailable', 'unavailable', now() - interval '7 hours')`;
    const db = database(storage);
    const binding = devinBinding(provider);
    const health = makeDriverAccountHealth(
      db,
      {
        binding: () => Effect.succeed(binding),
        // The registration as the pool registry now builds it for Devin: no check.
        checkable: () => Effect.succeed(false),
        source: () =>
          Effect.succeed({
            binding,
            source: { kind: "driver" as const, id: "basalt-home", version: "oauth-v1" },
            current: Effect.succeed(binding),
          }),
      },
      { status: () => "check_failed", message: () => undefined },
    );
    return { sql, health };
  });
const run = <A, E>(work: Effect.Effect<A, E, SqlClient.SqlClient>) =>
  Effect.runPromise(Effect.scoped(work).pipe(Effect.provide(pgliteLayer())));

test("a stored Service unavailable result of a subscription without a check reads as no check", async () => {
  const { identity: provider } = await identity("devin");
  const driver = await run(
    Effect.gen(function* () {
      const { health } = yield* seeded(provider);
      return (yield* health.report(stored(provider)))?.driver;
    }),
  );
  // With no result and nothing able to check it, the account list's Health cell stays empty.
  assert.deepEqual(
    { checkable: driver?.checkable, check: driver?.check },
    { checkable: false, check: null },
  );
});

test("the recheck runner records no check once, and the account leaves the recheck queue", async () => {
  const { identity: provider } = await identity("devin");
  const result = await run(
    Effect.gen(function* () {
      const { sql, health } = yield* seeded(provider);
      const queue = makeAccountRecheckQueue(sql);
      const checks: string[] = [];
      const executor = {
        accounts: {
          health: () =>
            health
              .report(stored(provider))
              .pipe(Effect.map((saved) => ({ account, apps: [], driver: saved?.driver }) as never)),
          check: (input: { readonly account: string }) =>
            Effect.gen(function* () {
              checks.push(input.account);
              yield* health.check(stored(provider) as never);
              return { account, apps: [] } as never;
            }),
        },
      };
      // The stored failure is past six hours, so today the queue claims the account again.
      const before = (yield* queue.claim("probe")).map((entry) => entry.account);
      yield* sql`delete from hosted_account_rechecks`;
      yield* sql`delete from hosted_account_recheck_families`;
      yield* makeAccountRechecks(sql, executor as never)("run-1");
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
  assert.deepEqual(result.checks, [account], "the runner asked the SDK to record the account once");
  assert.deepEqual(result.row, { checkable: false, status: null });
  assert.equal(result.lease?.outcome, "skipped");
  assert.ok(result.lease!.waits < 15 * 60, "no 15-minute retry is scheduled");
  assert.deepEqual(result.again, [], "past the six-hour mark, the account is not claimed again");
});
