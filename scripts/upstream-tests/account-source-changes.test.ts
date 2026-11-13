import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { Crypto, Effect, Redacted } from "effect";
import { SqlClient } from "effect/sql";
import { makeExecutorStorage } from "../../.upstream/packages/sdk/src/implementation/storage.ts";
import { makeChangeJournal } from "../../.upstream/apps/hosted/server/src/implementation/change-revisions.ts";
import { database } from "../../.upstream/packages/sdk/src/implementation/database.ts";
import { aesGcmCredentials } from "../../.upstream/packages/sdk/src/implementation/credentials.ts";
import { makeAppConnections } from "../../.upstream/packages/sdk/src/implementation/app-connections.ts";
import {
  AccountId,
  AppId,
  OwnerId,
  VersionId,
} from "../../.upstream/packages/sdk/src/contracts/shared.ts";
import { AppConnectionId } from "../../.upstream/packages/sdk/src/contracts/app-calls.ts";
import { fixture, key } from "./account-change-fixture.ts";

test("revoking a managed source through the real connection writer advances scoped account and app revisions", () =>
  fixture(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const journal = makeChangeJournal(sql);
      const read = () => journal.current("organization:team-a", [key("accounts"), key("apps")]);
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
      const identity = {
        app: AppId.make("app_a"),
        owner: OwnerId.make("organization:team-a"),
        dependency: "accountView",
        scope: "app" as const,
        target: AppId.make("app_a"),
      };
      const encrypted = yield* store.seal(AppConnectionId.make("acn_source"), {
        declaration: { scope: "app", cardinality: "many", tools: {} },
        accounts: { app: { models: [AccountId.make("acc_a")] }, user: {} },
        selections: [
          {
            scope: "app",
            requirement: "models",
            account: AccountId.make("acc_a"),
            source: {
              app: identity.target,
              version: VersionId.make("dpl_source"),
              scope: "app",
              requirement: "models",
            },
          },
        ],
      });
      yield* sql`insert into executor_app_connections
        (id,app,owner,dependency,subject,target,authorizer,revision,enabled,encrypted,created_at,updated_at)
        values ('acn_source','app_a','organization:team-a','accountView','','app_a','viewer-a',1,true,${encrypted},now(),now())`;
      const before = yield* read();
      const revoked = yield* store.operations.update({ ...identity, revision: 1, enabled: false });
      assert.equal(revoked.enabled, false);
      const after = yield* read();
      for (const [i, topic] of ["accounts", "apps"].entries())
        assert.equal(
          BigInt(after[i]!.revision),
          BigInt(before[i]!.revision) + 1n,
          `source revocation must move the ${topic} head`,
        );
      yield* sql`update executor_app_connections set updated_at=now()`;
      assert.deepEqual(yield* read(), after, "timestamp bookkeeping does not change selections");
      yield* sql
        .withTransaction(
          store.operations
            .update({ ...identity, revision: revoked.revision, enabled: true })
            .pipe(Effect.andThen(Effect.fail("rollback"))),
        )
        .pipe(Effect.result);
      assert.deepEqual(yield* read(), after, "rolled-back authority writes publish no head");
      const selected = yield* store.bindings.rewrite({
        ...identity,
        revision: revoked.revision,
        enabled: true,
        accounts: { app: { models: [AccountId.make("acc_a")] }, user: {} },
        selections: [
          {
            scope: "app",
            requirement: "models",
            account: AccountId.make("acc_a"),
            source: {
              app: identity.target,
              version: VersionId.make("dpl_selected"),
              scope: "app",
              requirement: "models",
            },
          },
        ],
      });
      const reselection = yield* read();
      for (let i = 0; i < 2; i++)
        assert.equal(BigInt(reselection[i]!.revision), BigInt(after[i]!.revision) + 1n);
      yield* sql`update executor_app_connections set encrypted=${yield* store.seal(
        AppConnectionId.make("acn_source"),
        {
          declaration: { scope: "app", cardinality: "many", tools: {} },
          accounts: { app: {}, user: {} },
          selections: [],
        },
      )}`;
      const payloadOnly = yield* read();
      for (let i = 0; i < 2; i++)
        assert.equal(
          BigInt(payloadOnly[i]!.revision),
          BigInt(reselection[i]!.revision) + 1n,
          "an encrypted selection or confirmation write must invalidate even without a revision bump",
        );
      yield* store.operations.remove({ ...identity, revision: selected.revision });
      const removed = yield* read();
      for (let i = 0; i < 2; i++)
        assert.equal(BigInt(removed[i]!.revision), BigInt(payloadOnly[i]!.revision) + 1n);
      assert.ok(
        (yield* journal.current("organization:team-b", [key("accounts"), key("apps")])).every(
          (head) => head.revision === "0",
        ),
      );
    }),
  ));
