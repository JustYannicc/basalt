import assert from "node:assert/strict";
import test from "node:test";
import { ControlFailure } from "./json.ts";
import { requireActivePoolOrganization } from "./organization-access.ts";
import { openEnvelope, signPoolToken } from "./token.ts";

const key = "ab".repeat(32),
  previous = "cd".repeat(32);
const claims = { pool: "pool-one", organization: "organization-one", owner: "owner-one" };
const request = async (signingKey = key) =>
  new Request("https://pool.test/pool/v1/usage/history", {
    headers: { authorization: `Bearer ${await signPoolToken(signingKey, claims)}` },
  });

test("retained app tokens recheck live authority on every request without a positive cache", async () => {
  let status = 204,
    calls = 0;
  const input = {
    signingKey: key,
    tools: {
      fetch: async (url: string, init: RequestInit) => {
        calls++;
        assert.equal(url, "https://tools/api/internal/pool-organization");
        const { envelope } = JSON.parse(String(init.body));
        const value = (await openEnvelope(key, "sbq1", envelope)) as Record<string, unknown>;
        assert.equal(value.organization, claims.organization);
        assert.equal(value.pool, claims.pool);
        assert.equal(Number(value.expiresAt) - Number(value.at), 30_000);
        return new Response(null, { status });
      },
    },
  };
  const token = await request();
  await requireActivePoolOrganization(token, input);
  status = 403;
  await assert.rejects(
    requireActivePoolOrganization(token, input),
    (error: unknown) => error instanceof ControlFailure && error.status === 403,
  );
  assert.equal(calls, 2);
});

test("a previous-key credential uses the current key for its fresh authority read", async () => {
  let calls = 0;
  await requireActivePoolOrganization(await request(previous), {
    signingKey: key,
    previousSigningKey: previous,
    tools: {
      fetch: async (_url, init) => {
        calls++;
        const { envelope } = JSON.parse(String(init.body));
        assert.ok(await openEnvelope(key, "sbq1", envelope));
        assert.equal(await openEnvelope(previous, "sbq1", envelope), undefined);
        return new Response(null, { status: 204 });
      },
    },
  });
  assert.equal(calls, 1);
});

test("authority outages and unexpected success responses fail closed", async () => {
  for (const status of [200, 401, 404, 503]) {
    await assert.rejects(
      requireActivePoolOrganization(await request(), {
        signingKey: key,
        tools: { fetch: async () => new Response(null, { status }) },
      }),
      (error: unknown) => error instanceof ControlFailure && error.status === 503,
    );
  }
});

test("invalid or unrelated credentials retain the endpoint's existing refusal", async () => {
  for (const token of ["", "invalid", "sbm1.invalid.invalid"]) {
    await requireActivePoolOrganization(
      new Request("https://pool.test/", {
        headers: { authorization: `Bearer ${token}` },
      }),
      {
        signingKey: key,
        tools: { fetch: async () => assert.fail("Invalid credential queried authority") },
      },
    );
  }
});
