import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { test } from "node:test";

const pgFixture = {
  active: true,
  connectError: undefined as Error | undefined,
  queryError: undefined as Error | undefined,
  options: [] as Record<string, unknown>[],
  queries: [] as { text: string; values: unknown[] }[],
  ended: 0,
};
Reflect.set(globalThis, "__basaltPgFixture", pgFixture);

const pgStub = `
  const fixture = globalThis.__basaltPgFixture;
  export default { Client: class {
    constructor(options) { fixture.options.push(options); }
    on() {}
    async connect() { if (fixture.connectError) throw fixture.connectError; }
    async query(text, values) {
      fixture.queries.push({ text, values });
      if (fixture.queryError) throw fixture.queryError;
      return { rows: [{ active: fixture.active }] };
    }
    async end() { fixture.ended += 1; }
  } };
`;
const pgModule = `data:text/javascript,${encodeURIComponent(pgStub)}`;
const hooks = registerHooks({
  resolve(specifier, context, next) {
    if (specifier === "pg") return { url: pgModule, shortCircuit: true };
    return next(specifier, context);
  },
});
const { hasActiveHomeApiKey, homeApiKeyCandidates } = await import("./model-auth.ts");
hooks.deregister();

function resetPgFixture(): void {
  pgFixture.active = true;
  pgFixture.connectError = undefined;
  pgFixture.queryError = undefined;
  pgFixture.options.length = 0;
  pgFixture.queries.length = 0;
  pgFixture.ended = 0;
}

test("Home model API-key candidates include every supported transport in order", () => {
  const request = new Request(
    "https://pool.example/v1/chat/completions?key=query-key&auth_token=query-token",
    {
      headers: {
        Authorization: "bEaReR bearer-key",
        "X-Goog-Api-Key": "google-key",
        "X-Api-Key": "api-key",
      },
    },
  );

  assert.deepEqual(homeApiKeyCandidates(request), {
    supplied: true,
    values: ["bearer-key", "google-key", "api-key", "query-key", "query-token"],
  });
});

test("Home model API-key candidates preserve Authorization raw fallback", () => {
  const request = new Request("https://pool.example/v1/models", {
    headers: { Authorization: "legacy-home-key" },
  });

  assert.deepEqual(homeApiKeyCandidates(request), {
    supplied: true,
    values: ["legacy-home-key"],
  });
});

test("missing model API-key candidates are distinguishable from invalid credentials", () => {
  const missing = homeApiKeyCandidates(new Request("https://pool.example/v1/models"));
  assert.deepEqual(missing, { supplied: false, values: [] });

  const empty = homeApiKeyCandidates(new Request("https://pool.example/v1/models?key=%20"));
  assert.equal(empty.supplied, true);
  assert.deepEqual(empty.values, []);
});

test("Home model-key lookup uses a parameterized active-row query and bounded timeouts", async () => {
  resetPgFixture();
  const connectionString = "postgres://fixture:fixture@database.invalid/basalt_pool";

  assert.equal(await hasActiveHomeApiKey(connectionString, ["wrong-key", "active-key"]), true);
  assert.deepEqual(pgFixture.options, [{
    connectionString,
    connectionTimeoutMillis: 2_500,
    query_timeout: 2_500,
    statement_timeout: 2_500,
  }]);
  assert.equal(pgFixture.queries.length, 1);
  assert.match(pgFixture.queries[0]!.text, /api_key = ANY\(\$1::text\[\]\)/);
  assert.match(pgFixture.queries[0]!.text, /deleted_at IS NULL/);
  assert.deepEqual(pgFixture.queries[0]!.values, [["wrong-key", "active-key"]]);
  assert.equal(pgFixture.ended, 1);
});

test("Home model-key lookup rejects soft-deleted revoked keys", async () => {
  resetPgFixture();
  pgFixture.active = false;

  assert.equal(await hasActiveHomeApiKey("postgres://fixture", ["revoked-key"]), false);
  assert.match(pgFixture.queries[0]!.text, /deleted_at IS NULL/);
});

test("Home model-key lookup surfaces connection and query failures", async () => {
  resetPgFixture();
  pgFixture.connectError = new Error("connect failed");
  await assert.rejects(hasActiveHomeApiKey("postgres://fixture", ["key"]), /connect failed/);
  assert.equal(pgFixture.ended, 0);

  pgFixture.connectError = undefined;
  pgFixture.queryError = new Error("query failed");
  await assert.rejects(hasActiveHomeApiKey("postgres://fixture", ["key"]), /query failed/);
  assert.equal(pgFixture.ended, 1);
});
