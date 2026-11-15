import assert from "node:assert/strict";
import { test } from "node:test";
import { Effect, Redacted } from "effect";
import { InMemoryService } from "alchemy/State/InMemoryState";
import { inspectionSqlSource } from "./sql-schema-sources.ts";

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
  await assert.rejects(
    Effect.runPromise(inspectionSqlSource(f.store)),
    /sql-schema-authority-unavailable/u,
  );
});
