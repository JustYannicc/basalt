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
  destroyed: 0,
  hangClose: false,
  hangConnect: false,
  activeKeys: undefined as string[] | undefined,
};
Reflect.set(globalThis, "__basaltPgFixture", pgFixture);

const pgStub = `
  const fixture = globalThis.__basaltPgFixture;
  export default { Client: class {
    connection = { stream: { destroy() { fixture.destroyed += 1; } } };
    constructor(options) { fixture.options.push(options); }
    on() {}
    async connect() {
      if (fixture.hangConnect) return new Promise(() => {});
      if (fixture.connectError) throw fixture.connectError;
    }
    async query(text, values) {
      fixture.queries.push({ text, values });
      if (fixture.queryError) throw fixture.queryError;
      if (values[0].includes(String.fromCharCode(0))) throw new Error('invalid text encoding');
      return { rows: [{ active: fixture.activeKeys ? fixture.activeKeys.includes(values[0]) : fixture.active }] };
    }
    async end() {
      fixture.ended += 1;
      if (fixture.hangClose) return new Promise(() => {});
    }
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
  pgFixture.destroyed = 0;
  pgFixture.hangClose = false;
  pgFixture.hangConnect = false;
  pgFixture.activeKeys = undefined;
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

test("query credentials normalize whitespace the same way as Home's database-key provider", () => {
  const request = new Request("https://pool.example/v1/models?key=%20active-key%20&auth_token=%C2%85active-key%C2%85");
  assert.deepEqual(homeApiKeyCandidates(request).values, ["active-key", "active-key"]);
});

test("Bearer extraction uses Home's Unicode whitespace rule", () => {
  const request = new Request("https://pool.example/v1/models", {
    headers: { Authorization: "Bearer \u0085active-key\u0085" },
  });
  assert.deepEqual(homeApiKeyCandidates(request).values, ["active-key"]);
});

test("Home model-key lookup uses a parameterized active-row query and bounded timeouts", async () => {
  resetPgFixture();
  const connectionString = "postgres://fixture:fixture@database.invalid/basalt_pool";
  pgFixture.activeKeys = ["active-key"];

  assert.equal(await hasActiveHomeApiKey(connectionString, ["wrong-key", "active-key"]), true);
  assert.deepEqual(pgFixture.options, [{
    connectionString,
    connectionTimeoutMillis: 2_500,
    query_timeout: 2_500,
    statement_timeout: 2_500,
  }]);
  assert.equal(pgFixture.queries.length, 2);
  assert.match(pgFixture.queries[0]!.text, /api_key = \$1/);
  assert.match(pgFixture.queries[0]!.text, /deleted_at IS NULL/);
  assert.deepEqual(pgFixture.queries.map((query) => query.values), [["wrong-key"], ["active-key"]]);
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
  assert.equal(pgFixture.ended, 1);

  pgFixture.connectError = undefined;
  pgFixture.queryError = new Error("query failed");
  await assert.rejects(hasActiveHomeApiKey("postgres://fixture", ["key"]), /query failed/);
  assert.equal(pgFixture.ended, 2);
});

test("the first active candidate wins before a later malformed PostgreSQL text value", async () => {
  resetPgFixture();
  pgFixture.activeKeys = ["active-key"];
  assert.equal(await hasActiveHomeApiKey("postgres://fixture", ["active-key", "\0"]), true);
  assert.deepEqual(pgFixture.queries.map((query) => query.values), [["active-key"]]);
  await assert.rejects(hasActiveHomeApiKey("postgres://fixture", ["\0", "active-key"]), /invalid text encoding/);
});

for (const phase of ["connect", "cleanup"]) {
  test(`the total lookup deadline force-closes stalled ${phase}`, async (t) => {
    resetPgFixture();
    t.mock.timers.enable({ apis: ["setTimeout"] });
    pgFixture.hangConnect = phase === "connect";
    pgFixture.hangClose = phase === "cleanup";
    const work = hasActiveHomeApiKey("postgres://fixture", ["active-key"]);
    const rejected = assert.rejects(work, /authentication deadline/);
    // Drain the successful connect and query before exercising stalled cleanup.
    for (let step = 0; step < 8; step += 1) await Promise.resolve();
    t.mock.timers.tick(6_000);
    await rejected;
    assert.equal(pgFixture.destroyed, 1);
    assert.equal(pgFixture.ended, phase === "cleanup" ? 1 : 0);
    t.mock.timers.reset();
  });
}
