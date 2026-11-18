// Every model request a device sends checks its bearer at the native access endpoint. These
// tests count the SQL statements one check runs and prove which events end a remembered answer.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { test, type TestContext } from "node:test";
import { fixture } from "./native-device-fixture.ts";

const origin = "http://localhost:3000";
/** The stated bound: a revocation made anywhere reaches every check within it. */
const bound = 3_000;
const pool = { id: "pool-fixture", name: "Pool fixture" };

/** A device approved for models and its team's tools, checked through the real endpoint. */
async function devices(t: TestContext) {
  t.mock.timers.enable({ apis: ["Date"], now: Date.now() });
  const db = new DatabaseSync(":memory:");
  t.after(() => db.close());
  const prepared = t.mock.method(db, "prepare");
  let team = "";
  let computers = 0;
  let slow = 0;
  const revoked = new Set<string>();
  const poolChecks: string[] = [];
  const f = await fixture(
    async (request) => {
      const { envelope } = await request.json();
      const value = JSON.parse(Buffer.from(envelope.split(".")[1], "base64url").toString());
      if (value.action === "register")
        return Response.json({
          computer: { id: `computer-${++computers}` },
          pool: pool.id,
          models: true,
          toolsOrganization: team,
        });
      if (value.action === "revoke") {
        revoked.add(value.computer);
        return Response.json({ revoked: true });
      }
      poolChecks.push(value.computer);
      t.mock.timers.tick(slow);
      return revoked.has(value.computer)
        ? new Response(null, { status: 401 })
        : Response.json({ active: true, display: { pool, pools: [pool] } });
    },
    undefined,
    db,
    { organizations: true },
  );
  t.after(() => f[Symbol.dispose]());
  // Hosts create teams through their own explicit-target endpoints; the rows are what checks read.
  team = (
    await f.adapter.create<{ id: string }>({
      model: "organization",
      data: { name: "Tools", slug: "tools", createdAt: new Date() },
    })
  ).id;
  await f.adapter.create({
    model: "member",
    data: { organizationId: team, userId: f.userId, role: "owner", createdAt: new Date() },
  });
  const approve = async (code: { user_code: string; device_code: string }) => {
    const approved = await f.request(
      "/device/decide",
      { user_code: code.user_code, accept: true },
      {
        "x-basalt-native-intent": "synthetic-intent",
        "x-basalt-native-name": "Test device",
        "x-basalt-native-pool": pool.id,
        "x-basalt-native-models": "true",
        "x-basalt-native-tools": "true",
      },
    );
    assert.equal(approved.status, 200, await approved.clone().text());
    const issued = await f.raw("/oauth2/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
        device_code: code.device_code,
        client_id: f.client_id,
        code_verifier: f.verifier,
        resource: `${origin}/native`,
      }),
    });
    assert.equal(issued.status, 200, await issued.clone().text());
    return (await issued.json()).access_token as string;
  };
  /** One check through the endpoint, with the SQL statements and pool checks it ran. */
  const access = async (bearer: string) => {
    prepared.mock.resetCalls();
    const asked = poolChecks.length;
    const response = await f.raw("/native/access", {
      headers: { authorization: `Bearer ${bearer}` },
    });
    const sql = prepared.mock.calls.map((call) => String(call.arguments[0]));
    const body = response.ok ? await response.json() : await response.body?.cancel();
    return { status: response.status, body, sql, pool: poolChecks.slice(asked) };
  };
  return {
    f,
    team,
    revoked,
    access,
    first: () => approve(f),
    another: async () => {
      const started = await f.raw("/oauth2/device-authorization", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          client_id: f.client_id,
          scope: "native offline_access",
          resource: `${origin}/native`,
          code_challenge: createHash("sha256").update(f.verifier).digest("base64url"),
          code_challenge_method: "S256",
        }),
      });
      assert.equal(started.status, 200, await started.clone().text());
      return approve(await started.json());
    },
    tick: (milliseconds: number) => t.mock.timers.tick(milliseconds),
    /** How long each pool check takes from now on. */
    slowPool: (milliseconds: number) => {
      slow = milliseconds;
    },
  };
}

const reads = (sql: readonly string[], table: string) =>
  sql.some((statement) => statement.includes(`"${table}"`));
const onlyBudget = (sql: readonly string[]) =>
  sql.length > 0 && sql.every((statement) => statement.includes(`"rateLimit"`));

test("a repeated device check runs only the device budget's statement", async (t) => {
  const d = await devices(t);
  const bearer = await d.first();
  const first = await d.access(bearer);
  assert.equal(first.status, 200);
  for (const table of ["oauthAccessToken", "mcpGrant", "oauthConsent", "member", "user"])
    assert.ok(reads(first.sql, table), `the first check reads ${table}`);
  const repeated = await d.access(bearer);
  assert.equal(repeated.status, 200);
  assert.deepEqual(repeated.body, first.body, "a remembered answer is the same answer");
  assert.ok(onlyBudget(repeated.sql), `a repeated check reads nothing: ${repeated.sql.join("; ")}`);
  assert.deepEqual(
    [first.pool, repeated.pool],
    [[first.body.policy.computer], [first.body.policy.computer]],
    "the pool is asked about the device on every check",
  );
  t.diagnostic(
    `statements per check: first ${first.sql.length}, repeated ${repeated.sql.length} (all budget)`,
  );
  d.tick(bound);
  const later = await d.access(bearer);
  assert.equal(later.status, 200);
  assert.ok(reads(later.sql, "oauthAccessToken"), "after the bound the check reads its rows again");
});

test("a slow pool check does not extend a remembered answer", async (t) => {
  const d = await devices(t);
  const bearer = await d.first();
  const readAt = Date.now();
  d.slowPool(2_000);
  const first = await d.access(bearer);
  assert.equal(first.status, 200);
  assert.equal(first.body.checkedAt, readAt, "the answer says when its rows were read");
  d.slowPool(0);
  d.tick(bound - 2_000 - 1);
  assert.ok(onlyBudget((await d.access(bearer)).sql));
  d.tick(1);
  const due = await d.access(bearer);
  assert.equal(due.status, 200);
  assert.ok(reads(due.sql, "oauthAccessToken"), "the bound counts from the read, not the reply");
});

test("a remembered answer is never served to another bearer", async (t) => {
  const d = await devices(t);
  const one = await d.first();
  const other = await d.another();
  const first = await d.access(one);
  assert.equal(first.status, 200);
  const second = await d.access(other);
  assert.equal(second.status, 200);
  assert.ok(reads(second.sql, "oauthAccessToken"), "another bearer is checked in full");
  assert.notEqual(second.body.id, first.body.id);
  assert.notEqual(second.body.policy.computer, first.body.policy.computer);
  assert.deepEqual(second.pool, [second.body.policy.computer]);
  for (const forged of ["unknown", `${one}x`, one.slice(0, -1)])
    assert.equal((await d.access(forged)).status, 401, "a bearer that was never issued");
  assert.equal((await d.access(one)).body.id, first.body.id);
  assert.equal((await d.access(other)).body.id, second.body.id);
});

test("a device its pool no longer admits is refused on its very next check", async (t) => {
  const d = await devices(t);
  const bearer = await d.first();
  const allowed = await d.access(bearer);
  assert.equal(allowed.status, 200);
  d.revoked.add(allowed.body.policy.computer);
  assert.equal((await d.access(bearer)).status, 401);
  d.revoked.delete(allowed.body.policy.computer);
  const again = await d.access(bearer);
  assert.equal(again.status, 200);
  assert.ok(reads(again.sql, "oauthAccessToken"), "a refusal forgets the remembered answer");
});

test("revoking the device's grant refuses its very next check", async (t) => {
  const d = await devices(t);
  const bearer = await d.first();
  assert.equal((await d.access(bearer)).status, 200);
  const revoked = await d.f.raw("/native/revoke", {
    method: "POST",
    headers: { authorization: `Bearer ${bearer}` },
  });
  assert.equal(revoked.status, 200, await revoked.clone().text());
  assert.equal((await d.access(bearer)).status, 401);
});

test("a revoked access token is refused once the bound has passed", async (t) => {
  const d = await devices(t);
  const bearer = await d.first();
  assert.equal((await d.access(bearer)).status, 200);
  const revoked = await d.f.raw("/oauth2/revoke", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      token: bearer,
      token_type_hint: "access_token",
      client_id: d.f.client_id,
    }),
  });
  assert.equal(revoked.status, 200, await revoked.clone().text());
  d.tick(bound);
  assert.equal((await d.access(bearer)).status, 401);
});

test("leaving the device's team refuses it once the bound has passed", async (t) => {
  const d = await devices(t);
  const bearer = await d.first();
  assert.equal((await d.access(bearer)).status, 200);
  await d.f.adapter.deleteMany({
    model: "member",
    where: [
      { field: "userId", value: d.f.userId },
      { field: "organizationId", value: d.team },
    ],
  });
  d.tick(bound);
  assert.equal((await d.access(bearer)).status, 401);
});

test("a remembered answer never outlives the token it was given for", async (t) => {
  const d = await devices(t);
  const bearer = await d.first();
  const allowed = await d.access(bearer);
  assert.equal(allowed.status, 200);
  d.tick(allowed.body.expiresAt - Date.now() - 1_000);
  assert.equal((await d.access(bearer)).status, 200);
  d.tick(1_001);
  assert.equal((await d.access(bearer)).status, 401);
});
