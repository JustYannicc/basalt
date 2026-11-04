import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import assert from "node:assert/strict";
import { test } from "node:test";
import { Effect, Option, Redacted, Schema } from "effect";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { cloudPoolGateway } from "../../.upstream/e2e/support/cloud-pool-gateway.ts";
import { poolAccessLifecycle } from "../../.upstream/apps/hosted/server/src/implementation/pool-access-hook.ts";
import { SqlClient } from "effect/sql";
import { pgliteLayer } from "../../.upstream/packages/fumadb-effect/src/pglite.ts";
import { makeExecutorStorage } from "../../.upstream/packages/sdk/src/implementation/storage.ts";
import { database } from "../../.upstream/packages/sdk/src/implementation/database.ts";
import { makeOwners } from "../../.upstream/packages/sdk/src/implementation/owners.ts";
import { AppFields } from "../../.upstream/packages/sdk/src/contracts/apps.ts";
import {
  OrganizationId,
  organizationOwner,
} from "../../.upstream/apps/hosted/server/src/contracts/organization.ts";
import { migrateOrganizationRemovals } from "../../.upstream/apps/hosted/server/src/implementation/organization-removal-schema.ts";
import { makeOrganizationRemovals } from "../../.upstream/apps/hosted/server/src/implementation/organization-removals.ts";
import { migrateResourceAccess } from "../../.upstream/apps/hosted/server/src/implementation/resource-schema.ts";
import {
  hostedResourceLifecycle,
  organizationAppCreation,
} from "../../.upstream/apps/hosted/server/src/implementation/resource-lifecycle.ts";

const fixture = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const storage = yield* makeExecutorStorage({ provider: "postgresql" });
  yield* storage.migrate;
  yield* sql`create table organization (id text primary key, metadata text)`;
  yield* sql`create table "user" (id text primary key)`;
  yield* sql`create table hosted_groups (organization_id text, id text)`;
  yield* migrateOrganizationRemovals;
  yield* migrateResourceAccess;
  const organization = OrganizationId.make("removal_fixture");
  const owner = organizationOwner(organization);
  yield* sql`insert into organization values (${organization}, '{}')`;
  const { hooks } = yield* hostedResourceLifecycle;
  const db = database(storage);
  const persist = (id: string) => {
    const app = Schema.decodeUnknownSync(AppFields)({
      id,
      code: `code_${id}`,
      owner,
      repository: null,
      name: id,
      slug: id.replaceAll("_", "-"),
      activeVersion: null,
      copiedFrom: null,
      createdAt: new Date(),
      requirements: { accounts: {} },
    });
    return db.transaction(
      Effect.gen(function* () {
        yield* db.create("apps", {
          id: app.id,
          code: app.code,
          repository: app.repository,
          owner: app.owner,
          name: app.name,
          slug: app.slug,
          activeDeployment: null,
          copiedFrom: null,
          createdAt: app.createdAt,
          deploySequence: 0,
          activatedSequence: 0,
        });
        yield* organizationAppCreation(hooks.appCreated(app));
      }),
    );
  };
  const { removals } = makeOrganizationRemovals(Effect.succeed(sql));
  return { sql, owner, organization, hooks, persist, removals, owners: makeOwners(db) };
});

test("an app finishing after organization removal was accepted cannot recreate saved state", async () => {
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const f = yield* fixture;
        yield* f.persist("app_before_removal");
        const first = yield* f.removals.begin(f.organization, f.organization);
        assert.equal(first.status, "running");
        const repeat = yield* f.removals.begin(f.organization, "different-instance");
        assert.equal(repeat.instance, first.instance);
        const late = yield* Effect.result(f.persist("app_late_build"));
        assert.equal(
          late._tag,
          "Failure",
          "a build that crossed removal acceptance must roll back",
        );
        assert.equal(late.failure._tag, "StorageError");
        const removed = yield* f.owners.remove({ owner: f.owner });
        assert.equal(removed.apps, 1);
        assert.deepEqual(yield* f.sql`select id from executor_apps where owner = ${f.owner}`, []);
        assert.deepEqual(yield* f.sql`select id from hosted_app_access`, []);
      }).pipe(Effect.provide(pgliteLayer()), Effect.provide(NodeCrypto.layer)),
    ),
  );
});

test("deployment persistence refuses tombstoned and deleted organizations", async () => {
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const f = yield* fixture;
        const deploying = f.hooks.appDeploying;
        assert.ok(deploying);
        yield* f.sql.withTransaction(deploying(f.owner));
        yield* f.removals.begin(f.organization, f.organization);
        const late = yield* Effect.result(f.sql.withTransaction(deploying(f.owner)));
        assert.equal(late._tag, "Failure", "a late deployment must observe the tombstone");
        assert.equal(late.failure._tag, "StorageError");
        yield* f.owners.remove({ owner: f.owner });
        yield* f.sql`delete from organization where id = ${f.organization}`;
        const deleted = yield* Effect.result(f.sql.withTransaction(deploying(f.owner)));
        assert.equal(deleted._tag, "Failure", "a deleted parent must be refused before saving");
        assert.equal(deleted.failure._tag, "StorageError");
        const replay = yield* f.removals.begin(f.organization, "different-instance");
        assert.equal(replay.instance, f.organization);
      }).pipe(Effect.provide(pgliteLayer()), Effect.provide(NodeCrypto.layer)),
    ),
  );
});

test("signed organization cleanup fails on a plain API and completes through the pool gateway", async () => {
  const directory = await mkdtemp(join(tmpdir(), "organization-removal-"));
  const previous = process.cwd();
  const plain = createServer((_request, response) => response.writeHead(404).end());
  await new Promise<void>((resolve) => plain.listen(0, "127.0.0.1", resolve));
  const address = plain.address();
  assert.ok(address && typeof address !== "string");
  const origin = `http://127.0.0.1:${address.port}`;
  try {
    process.chdir(fileURLToPath(new URL("../../.upstream/", import.meta.url)));
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const f = yield* fixture;
          yield* f.persist("app_callback");
          yield* f.sql`update organization set metadata =
        '{"basaltPools":{"fixture":{"app":"app_callback"}}}' where id = ${f.organization}`;
          const key = Option.some(Redacted.make("ab".repeat(32)));
          const withoutGateway = poolAccessLifecycle(key, origin).organizationRemoving;
          assert.ok(withoutGateway);
          const failure = yield* Effect.result(withoutGateway(f.organization));
          assert.equal(failure._tag, "Failure");
          assert.equal(failure.failure._tag, "StorageError");
          const gateway = yield* cloudPoolGateway(origin, directory, new URL(origin));
          const withGateway = poolAccessLifecycle(key, gateway.href).organizationRemoving;
          assert.ok(withGateway);
          yield* withGateway(f.organization);
          const events = yield* Effect.promise(() =>
            fetch(new URL("/native-provider-fixture/backend-events", gateway)).then((response) =>
              response.json(),
            ),
          );
          assert.deepEqual(events, [
            { path: "/pool/v1/access", action: "pool-deleted", refused: false },
          ]);
        }).pipe(
          Effect.provide(pgliteLayer()),
          Effect.provide(NodeCrypto.layer),
          Effect.provide(NodeServices.layer),
        ),
      ),
    );
  } finally {
    process.chdir(previous);
    plain.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      plain.close((error) => (error ? reject(error) : resolve())),
    );
    await rm(directory, { recursive: true, force: true });
  }
});
