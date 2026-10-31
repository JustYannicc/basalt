import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { test } from "node:test";
import { PGlite } from "../../.upstream/node_modules/@electric-sql/pglite/dist/index.js";
import { backendUserName, digest } from "../../src/pool/backend-users.ts";
import { NativeMemberships } from "../../src/pool/membership.ts";
import { membershipPrefix, policyHeader, policyUsePrefix } from "../../src/pool/membership-contract.ts";
import { openEnvelope, signEnvelope } from "../../src/pool/token.ts";

const database = new PGlite();
Reflect.set(globalThis, "__nativeMembershipDb", database);
const hooks = registerHooks({ resolve(specifier, context, next) {
  if (specifier === "pg") return {
    url: 'data:text/javascript,' + encodeURIComponent(`export default { Client: class {
      on() {} async connect() {} async end() {}
      async query(text, values) { return globalThis.__nativeMembershipDb.query(text, values); }
    } };`), shortCircuit: true,
  };
  return next(specifier, context);
} });
const { modelMembership, ModelMembershipUnavailable } = await import("../../src/pool/model-membership.ts");
// pg is loaded lazily on the first scope read.
const key = "ab".repeat(32);

test("verified Home key scope selects native authority and preserves an unrelated legacy pool", async () => {
  const values = new Map<string, unknown>();
  const memberships = new NativeMemberships({
    storage: { get: async <T>(name: string) => structuredClone(values.get(name)) as T | undefined,
      put: async (name, value) => { values.set(name, structuredClone(value)); } },
    signingKey: key, read: async (pool, organization) => ({ pool, organization, native: true, accounts: [] }),
    reconcile: async () => {}, actual: async () => [], install: async () => {}, abort: () => {}, schedule: async () => {},
  });
  const now = Date.now();
  const reserve = () => memberships.reserve(new Request("https://pool/pool/v1/membership", {
    method: "POST", body: JSON.stringify({ envelope: null }),
  }));
  const signed = await signEnvelope(key, membershipPrefix, { pool: "a", organization: "org", at: now, expiresAt: now + 30_000 });
  await memberships.reserve(new Request("https://pool/pool/v1/membership", { method: "POST", body: JSON.stringify({ envelope: signed }) }));
  await memberships.tick();
  try {
    await database.exec(`CREATE TABLE api_key (id bigint,api_key text,channels jsonb,user_id bigint,deleted_at timestamptz);
      CREATE TABLE "user" (id bigint,username text);
      CREATE TABLE channel_group (id bigint,channel_name text,deleted_at timestamptz);
      INSERT INTO channel_group VALUES (1,'signalbox-pool-a',NULL),(2,'signalbox-pool-b',NULL);
      INSERT INTO api_key VALUES (1,'native','[1]',1,NULL),(2,'legacy','[2]',2,NULL),
        (3,'multiple','[1,2]',1,NULL),(4,'unrestricted','[]',1,NULL);`);
    await database.query('INSERT INTO "user" VALUES (1,$1),(2,$2)', [await backendUserName("person", "a"), await backendUserName("other", "b")]);
    const request = (credential: string) => new Request("https://pool/v1/responses", {
      headers: { Authorization: `Bearer ${credential}`, [policyHeader]: "forged-client-policy" },
    });
    const native = await modelMembership(request("native"), memberships, key, "postgres://fixture");
    assert.equal(native.pool, "a");
    assert.equal(native.identity?.person, await digest("person"));
    const assertion = await openEnvelope(key, policyUsePrefix, native.request.headers.get(policyHeader)!);
    assert.ok(assertion && typeof assertion === "object" && "pool" in assertion && assertion.pool === "a");
    const legacy = await modelMembership(request("legacy"), memberships, key, "postgres://fixture");
    assert.equal(legacy.pool, "b");
    assert.equal(legacy.request.headers.has(policyHeader), false);
    for (const credential of ["missing", "multiple", "unrestricted"])
      await assert.rejects(modelMembership(request(credential), memberships, key, "postgres://fixture"), ModelMembershipUnavailable);
    await assert.rejects(reserve());
    // A second signed reservation invalidates the first model assertion before native SQL can commit.
    await memberships.reserve(new Request("https://pool/pool/v1/membership", { method: "POST", body: JSON.stringify({ envelope: signed }) }));
    await assert.rejects(modelMembership(request("native"), memberships, key, "postgres://fixture"), ModelMembershipUnavailable);
    assert.equal((await modelMembership(request("legacy"), memberships, key, "postgres://fixture")).pool, "b");
  } finally {
    hooks.deregister();
    await database.close();
    Reflect.deleteProperty(globalThis, "__nativeMembershipDb");
  }
});
