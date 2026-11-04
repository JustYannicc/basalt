import assert from "node:assert/strict";
import { test } from "node:test";
import { HomeClient } from "./control.ts";
import { backendUserName, digest } from "./backend-users.ts";
import { sessionSuccess } from "./model-history/session-success.ts";

test("session proof requires both the authorized saved account and the exact successful session", async () => {
  const caller = { user: "fixture-owner", pool: "pool-fixture" };
  const username = await backendUserName(caller.user, caller.pool);
  const session = crypto.randomUUID(),
    source = await digest("home-local-v1"),
    at = new Date().toISOString();
  const history = await digest(JSON.stringify([source, "account", "raw-ref"]));
  const authority = {
    canManage: true,
    mappingProven: true,
    accounts: [{ account: "acc_visible", history: [history] }],
  };
  for (const [reference, actualSession, expected] of [
    ["raw-ref", session, at],
    ["other-ref", session, null],
    ["raw-ref", crypto.randomUUID(), null],
  ] as const) {
    const home = new HomeClient(async (path) =>
      path.endsWith("/users")
        ? Response.json({ users: [{ id: 1, username }] })
        : Response.json({
            total: 1,
            items: [
              {
                session_id: actualSession,
                status: "success",
                timestamp: at,
                credential: { credential_id: reference },
                client: { user_id: 1, username, api_key_id: 11 },
              },
            ],
          }),
    );
    const result = await sessionSuccess(
      home,
      { pool: caller.pool, accounts: ["acc_visible"], session },
      authority,
      caller,
    );
    assert.deepEqual(result.accounts, [{ account: "acc_visible", lastSuccessAt: expected }]);
    assert.ok(!JSON.stringify(result).includes("raw-ref"));
  }
  await assert.rejects(
    sessionSuccess(
      new HomeClient(async () => {
        throw new Error("must not read");
      }),
      { pool: caller.pool, accounts: ["acc_hidden"], session },
      authority,
      caller,
    ),
  );
});

test("signed caller and pool cannot probe another caller's session through a shared account", async () => {
  const { handleUsageSeries, lastSuccessAtPath } = await import("./model-history/series-http.ts");
  const { signEnvelope } = await import("./token.ts");
  const { backendUserName } = await import("./backend-users.ts");
  const signingKey = "ab".repeat(32),
    session = crypto.randomUUID();
  const source = await digest("home-local-v1"),
    history = await digest(JSON.stringify([source, "account", "shared-ref"]));
  const users = [
    { id: 1, username: await backendUserName("alice", "pool-a") },
    { id: 2, username: await backendUserName("bob", "pool-b") },
    { id: 3, username: await backendUserName("alice", "pool-b") },
    { id: 4, username: await backendUserName("bob", "pool-a") },
  ];
  const queries: URL[] = [];
  const home = new HomeClient(async (path) => {
    const url = new URL(path, "https://home.invalid");
    if (url.pathname.endsWith("/users")) return Response.json({ users });
    assert.ok(url.pathname.endsWith("/usage/records"));
    queries.push(url);
    // Intentionally ignore query filters: the application must recheck trusted row association.
    return Response.json({
      total: 1,
      items: [
        {
          session_id: session,
          status: "success",
          timestamp: "2026-11-04T12:00:00.000Z",
          credential: { credential_id: "shared-ref" },
          client: { api_key_id: 22, user_id: 2, username: users[1]!.username },
        },
      ],
    });
  });
  const read = async (user: string, pool: string) => {
    const envelope = await signEnvelope(signingKey, "sbs1", {
      action: "lastSuccessAt",
      pool,
      user,
      organization: "org-fixture",
      expiresAt: Date.now() + 30_000,
      input: { pool, session, accounts: ["acc_shared"] },
      authority: { canManage: true, accounts: [{ account: "acc_shared", history: [history] }] },
    });
    const response = await handleUsageSeries(
      new Request(`https://pool.invalid${lastSuccessAtPath}`, {
        method: "POST",
        body: JSON.stringify({ envelope }),
      }),
      { home, signingKey, connectionString: undefined },
    );
    assert.equal(response.status, 200);
    return response.json();
  };
  for (const [user, pool, expected] of [
    ["alice", "pool-a", null],
    ["alice", "pool-b", null],
    ["bob", "pool-a", null],
    ["bob", "pool-b", "2026-11-04T12:00:00.000Z"],
  ] as const) {
    const result = await read(user, pool);
    assert.deepEqual(result.accounts, [{ account: "acc_shared", lastSuccessAt: expected }]);
  }
  assert.deepEqual(
    queries.map((url) => url.searchParams.get("user_id")),
    ["1", "3", "4", "2"],
  );
});

test("missing or inconsistent Home client associations never verify a session", async () => {
  const caller = { user: "alice", pool: "pool-a" },
    username = await backendUserName(caller.user, caller.pool);
  const session = crypto.randomUUID(),
    source = await digest("home-local-v1");
  const history = await digest(JSON.stringify([source, "account", "shared-ref"]));
  const authority = {
    canManage: true,
    mappingProven: true,
    accounts: [{ account: "acc_shared", history: [history] }],
  };
  for (const client of [
    undefined,
    { user_id: 2, username, api_key_id: 10 },
    { user_id: 1, username: "foreign", api_key_id: 10 },
    { user_id: 1, username },
    { user_id: 1, username, api_key_id: 0 },
  ]) {
    const home = new HomeClient(async (path) =>
      path.endsWith("/users")
        ? Response.json({ users: [{ id: 1, username }] })
        : Response.json({
            total: 1,
            items: [
              {
                session_id: session,
                status: "success",
                timestamp: new Date().toISOString(),
                credential: { credential_id: "shared-ref" },
                client,
              },
            ],
          }),
    );
    const result = await sessionSuccess(
      home,
      { pool: caller.pool, session, accounts: ["acc_shared"] },
      authority,
      caller,
    );
    assert.deepEqual(result.accounts, [{ account: "acc_shared", lastSuccessAt: null }]);
  }
  const home = new HomeClient(async (path) => {
    assert.ok(path.endsWith("/users"), "An unprovisioned caller must not query global sessions");
    return Response.json({ users: [] });
  });
  const result = await sessionSuccess(
    home,
    { pool: caller.pool, session, accounts: ["acc_shared"] },
    authority,
    caller,
  );
  assert.deepEqual(result.accounts, [{ account: "acc_shared", lastSuccessAt: null }]);
});
