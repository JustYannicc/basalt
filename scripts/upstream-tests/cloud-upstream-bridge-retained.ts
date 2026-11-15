import assert from "node:assert/strict";
import { fumadb } from "fumadb-effect";
import { sqlAdapter } from "fumadb-effect/sql";
import { Effect, SqlClient } from "./cloud-upstream-bridge-fixtures.ts";
import { storageSchemas } from "../../.upstream/packages/sdk/src/implementation/storage-migrations.ts";

const plaintext = new TextEncoder().encode('{"fixture":"encrypted account and pending input"}');

/** Real 4.0.28 tables, rather than current tables relabelled as an older layout. */
export const seedEncryptedSdk = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const database = fumadb({ namespace: "executor", schemas: storageSchemas });
  const migrator = yield* database.client(sqlAdapter({ provider: "postgresql" })).createMigrator;
  yield* (yield* migrator.migrateTo("4.0.28")).execute;
  const key = yield* Effect.promise(() =>
    crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, true, ["encrypt", "decrypt"]),
  );
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = yield* Effect.promise(() =>
    crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, plaintext),
  );
  const hex = Buffer.from(encrypted).toString("hex");
  yield* sql`insert into executor_providers (id, definition) values ('provider_bridge', '{}'::jsonb)`;
  yield* sql`insert into executor_accounts
    (id, owner, provider, method, label, encrypted_credentials, created_at, site)
    values ('account_bridge', 'user_bridge', 'provider_bridge', 'token', 'Fixture', decode(${hex}, 'hex'), now(), 'https://bridge.invalid')`;
  yield* sql`insert into executor_account_targets
    (account, owner, revision, mode, enabled, device, device_name, binding, manifest_revision)
    values ('account_bridge', 'user_bridge', 1, 'device', true, 'device_bridge', 'Fixture', 'binding_bridge', 'manifest_bridge')`;
  yield* sql`insert into executor_app_call_receipts
    (id, app, owner, connection, state, deadline, encrypted, created_at, updated_at)
    values ('receipt_bridge', 'app_bridge', 'user_bridge', 'connection_bridge', 'pending', now() + interval '1 day', decode(${hex}, 'hex'), now(), now())`;
  yield* sql`insert into executor_workflow_inputs
    (id, app, run, owner, actor, status, expires_at, wake_pending, answered_by, encrypted, created_at)
    values ('input_bridge', 'app_bridge', 'run_bridge', 'user_bridge', 'user_bridge', 'pending', now() + interval '1 day', false, null, decode(${hex}, 'hex'), now())`;
  return { key, iv, hex };
});

export const retainedSdk = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  return {
    version: yield* sql`select value from private_executor_settings where key = 'version'`,
    account:
      yield* sql`select id, owner, provider, method, label, site, encode(encrypted_credentials, 'hex') as encrypted from executor_accounts`,
    targets: yield* sql`select * from executor_account_targets`,
    receipts:
      yield* sql`select id, state, encode(encrypted, 'hex') as encrypted from executor_app_call_receipts`,
    inputs:
      yield* sql`select id, status, encode(encrypted, 'hex') as encrypted from executor_workflow_inputs`,
  };
});

export const decryptRetained = (fixture: Effect.Success<typeof seedEncryptedSdk>) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const records = yield* sql<{
      encrypted: string;
    }>`select encode(encrypted_credentials, 'hex') as encrypted from executor_accounts
    union all select encode(encrypted, 'hex') from executor_app_call_receipts
    union all select encode(encrypted, 'hex') from executor_workflow_inputs`;
    assert.equal(records.length, 3);
    for (const row of records) {
      assert.equal(row.encrypted, fixture.hex);
      const decrypted = yield* Effect.promise(() =>
        crypto.subtle.decrypt(
          { name: "AES-GCM", iv: fixture.iv },
          fixture.key,
          Buffer.from(row.encrypted, "hex"),
        ),
      );
      assert.deepEqual(new Uint8Array(decrypted), plaintext);
    }
  });
