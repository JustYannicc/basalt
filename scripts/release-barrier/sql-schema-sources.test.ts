import assert from "node:assert/strict";
import { test } from "node:test";
import { Effect, Redacted } from "effect";
import { InMemoryService } from "alchemy/State/InMemoryState";
import {
  deploymentSqlSources,
  inspectionSqlSource,
  SqlSchemaAuthorityFailure,
} from "./sql-schema-sources.ts";

const url = "postgresql://fixture:private-password@database.example.test/tools?sslmode=require";
async function fixture(status: "created" | "updating", oldUrl = url) {
  const store = await Effect.runPromise(InMemoryService());
  const props = { env: { DATABASE_URL: Redacted.make(url) } };
  const value = {
    resourceType: "Command.Exec",
    namespace: undefined,
    fqn: "Migrations",
    logicalId: "Migrations",
    instanceId: "fixture",
    providerVersion: 1,
    downstream: [],
    bindings: [],
    props,
    attr: {},
  };
  await Effect.runPromise(
    store.set({
      stack: "basalt",
      stage: "production",
      fqn: "Migrations",
      value:
        status === "created"
          ? { ...value, status }
          : {
              ...value,
              status,
              old: {
                props: { env: { DATABASE_URL: Redacted.make(oldUrl) } },
                bindings: [],
                attr: {},
              },
            },
    }),
  );
  const reads: string[] = [];
  return {
    reads,
    store: {
      ...store,
      get: (request: Parameters<typeof store.get>[0]) => {
        reads.push(request.fqn);
        assert.equal(request.stack, "basalt");
        assert.equal(request.stage, "production");
        return store.get(request);
      },
    },
  };
}

test("inspection takes only existing Migrations authority, including a failed update with unchanged authority", async () => {
  for (const status of ["created", "updating"] as const) {
    const f = await fixture(status);
    const source = await Effect.runPromise(inspectionSqlSource(f.store));
    assert.equal(source.databaseName, "tools");
    assert.deepEqual(f.reads, ["Migrations"]);
    assert.doesNotMatch(JSON.stringify(source), /private-password|database\.example/u);
  }
});

test("a failed update with changed SQL authority refuses instead of choosing a database", async () => {
  const f = await fixture("updating", url.replace("/tools?", "/other?"));
  await assert.rejects(Effect.runPromise(inspectionSqlSource(f.store)), (error) => {
    assert.ok(error instanceof SqlSchemaAuthorityFailure);
    assert.deepEqual(error.authority, {
      resource: "Migrations",
      check: "updating-authority-drift",
      status: "updating",
    });
    assert.doesNotMatch(
      JSON.stringify(error.authority),
      /private-password|database\.example|other/u,
    );
    return true;
  });
});

test("a preflight reads the authority an interrupted release will resume with; the release refuses it", async () => {
  const store = await Effect.runPromise(InMemoryService());
  const next = { Migrations: url.replace("/tools?", "/tools_next?"), PoolDatabase: url };
  for (const [fqn, key] of [
    ["Migrations", "DATABASE_URL"],
    ["PoolDatabase", "POOL_DATABASE_ADMIN_URL"],
  ] as const)
    await Effect.runPromise(
      store.set({
        stack: "basalt",
        stage: "production",
        fqn,
        value: {
          resourceType: "Command.Exec",
          namespace: undefined,
          fqn,
          logicalId: fqn,
          instanceId: "fixture",
          providerVersion: 1,
          downstream: [],
          bindings: [],
          status: "updating",
          props: { env: { [key]: Redacted.make(next[fqn]) } },
          old: {
            props: { env: { [key]: Redacted.make(url.replace("/tools?", "/old?")) } },
            bindings: [],
            attr: {},
          },
          attr: {},
        },
      }),
    );
  const stack = { name: "basalt", stage: "production" };
  const { sources } = await Effect.runPromise(deploymentSqlSources(store, stack, "next"));
  assert.equal(sources.tools.databaseName, "tools_next");
  assert.equal(sources.pool.databaseName, "basalt_pool");
  await assert.rejects(
    Effect.runPromise(deploymentSqlSources(store, stack)),
    (error) =>
      error instanceof SqlSchemaAuthorityFailure && error.authority.check === "resource-status",
  );
});
