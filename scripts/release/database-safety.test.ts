import assert from "node:assert/strict";
import { createServer } from "node:http";
import { test } from "node:test";
import { Effect, Exit, Redacted } from "effect";
import { FetchHttpClient } from "effect/http";
import { PGlite } from "../../.upstream/node_modules/@electric-sql/pglite/dist/index.js";
import {
  compareSnapshots,
  DatabaseSafetyRefusal,
  readSnapshot,
  takeBackup,
  type DatabaseSnapshot,
  type Session,
} from "./database-safety.ts";

// Columns follow Home v1.1.6's `auth` and `home_schema_migration` and the pool's history table.
async function poolDatabase() {
  const database = new PGlite();
  await database.exec(`
    CREATE SCHEMA home;
    CREATE TABLE home.auth (id text PRIMARY KEY, disabled boolean NOT NULL DEFAULT false, deleted_at timestamptz);
    CREATE TABLE home.home_schema_migration (id text PRIMARY KEY, version bigint NOT NULL, updated_at timestamptz);
    INSERT INTO home.home_schema_migration VALUES ('schema', 41, now());
    INSERT INTO home.auth (id, deleted_at) VALUES ('a', NULL), ('b', NULL), ('c', now());
    CREATE TABLE public.basalt_model_requests (id text, timestamp timestamptz) PARTITION BY HASH (id);
    CREATE TABLE public.basalt_model_requests_0 PARTITION OF public.basalt_model_requests FOR VALUES WITH (MODULUS 2, REMAINDER 0);
    CREATE TABLE public.basalt_model_requests_1 PARTITION OF public.basalt_model_requests FOR VALUES WITH (MODULUS 2, REMAINDER 1);
    INSERT INTO public.basalt_model_requests SELECT 'r' || g, now() FROM generate_series(1, 25) g;
  `);
  const session: Session = { query: (text, values) => database.query(text, values) as never };
  return { database, session };
}

const failure = <A>(exit: Exit.Exit<A, unknown>) => {
  assert.equal(Exit.isFailure(exit), true);
  const error = Exit.isFailure(exit) ? (exit.cause as unknown) : undefined;
  return JSON.stringify(error, (_key, value) =>
    value instanceof Error ? { ...value, message: value.message } : value,
  );
};

test("the snapshot counts live accounts, history rows and Home's schema version read-only", async () => {
  const { session } = await poolDatabase();
  const snapshot = await Effect.runPromise(readSnapshot(session));
  assert.deepEqual(snapshot, {
    homes: [{ schema: "home", accounts: 2, schemaVersion: 41 }],
    historyRows: 25,
  });
});

test("the snapshot transaction cannot write", async () => {
  const { session } = await poolDatabase();
  const writing: Session = {
    query: async (text, values) => {
      const result = await session.query(text, values);
      if (text.startsWith("SET LOCAL"))
        await session.query("INSERT INTO home.auth (id) VALUES ('w')");
      return result;
    },
  };
  const exit = await Effect.runPromiseExit(readSnapshot(writing));
  assert.match(failure(exit), /snapshot-read/u);
});

const before: DatabaseSnapshot = {
  homes: [{ schema: "home", accounts: 6, schemaVersion: 41 }],
  historyRows: 2_263_794,
};

test("unchanged or growing counts pass", async () => {
  await Effect.runPromise(compareSnapshots(before, before));
  await Effect.runPromise(
    compareSnapshots(before, {
      homes: [{ schema: "home", accounts: 7, schemaVersion: 41 }],
      historyRows: 2_263_800,
    }),
  );
});

test("a lost account, lost history or a moved Home schema refuses and names the values", async () => {
  const exit = await Effect.runPromiseExit(
    compareSnapshots(before, {
      homes: [{ schema: "home", accounts: 5, schemaVersion: 42 }],
      historyRows: 2_263_793,
    }),
  );
  const text = failure(exit);
  assert.match(text, /"check":"accounts".*"before":6.*"after":5/u);
  assert.match(text, /"check":"home-schema-version".*"before":41.*"after":42/u);
  assert.match(text, /"check":"history".*"before":2263794.*"after":2263793/u);
});

test("a missing Home schema after the deploy refuses", async () => {
  const exit = await Effect.runPromiseExit(
    compareSnapshots(before, { homes: [], historyRows: 2_263_794 }),
  );
  assert.match(failure(exit), /home-schemas/u);
});

async function planetScale(states: string[], name = "basalt-release-v3-test") {
  const seen: string[] = [];
  const server = createServer((request, response) => {
    seen.push(
      `${request.method} ${request.url} ${request.headers.authorization === "id:secret" ? "auth" : "no-auth"}`,
    );
    const state = request.method === "POST" ? "pending" : (states.shift() ?? "pending");
    response.writeHead(request.method === "POST" ? 201 : 200, {
      "content-type": "application/json",
    });
    // Extra keys like the real API returns; decoding must ignore them.
    response.end(
      JSON.stringify({ id: "bk1", name, state, protected: false, size: 1, type: "Backup" }),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as { port: number };
  return { origin: `http://127.0.0.1:${port}/v1`, seen, close: () => server.close() };
}

const backup = (origin: string, timeout = "5 seconds" as const) =>
  takeBackup({
    organization: "org",
    tokenId: Redacted.make("id"),
    token: Redacted.make("secret"),
    database: "basalt",
    branch: "main",
    name: "basalt-release-v3-test",
    apiOrigin: origin,
    timeout,
    pollEvery: "50 millis",
  }).pipe(Effect.provide(FetchHttpClient.layer));

test("the backup is created once and waited until PlanetScale reports success", async () => {
  const api = await planetScale(["running", "success"]);
  try {
    const result = await Effect.runPromise(backup(api.origin));
    assert.deepEqual(result, { id: "bk1", name: "basalt-release-v3-test" });
    assert.deepEqual(api.seen, [
      "POST /v1/organizations/org/databases/basalt/branches/main/backups auth",
      "GET /v1/organizations/org/databases/basalt/branches/main/backups/bk1 auth",
      "GET /v1/organizations/org/databases/basalt/branches/main/backups/bk1 auth",
    ]);
  } finally {
    api.close();
  }
});

test("a failed backup refuses with its state", async () => {
  const api = await planetScale(["failed"]);
  try {
    const exit = await Effect.runPromiseExit(backup(api.origin));
    assert.match(failure(exit), /backup-failed.*"state":"failed"/u);
  } finally {
    api.close();
  }
});

test("a backup that never completes refuses at its deadline", async () => {
  const api = await planetScale([]);
  try {
    const exit = await Effect.runPromiseExit(backup(api.origin, "1 second" as never));
    assert.match(failure(exit), /backup-timeout/u);
  } finally {
    api.close();
  }
});

test("a backup under another name refuses", async () => {
  const api = await planetScale(["success"], "someone-else");
  try {
    const exit = await Effect.runPromiseExit(backup(api.origin));
    assert.match(failure(exit), /backup-identity/u);
  } finally {
    api.close();
  }
});

test("refusals are tagged", () => {
  assert.equal(
    new DatabaseSafetyRefusal({ check: "x", why: "y", fix: "z" })._tag,
    "DatabaseSafetyRefusal",
  );
});
