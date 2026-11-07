import assert from "node:assert/strict";
import test from "node:test";
import { callerHeader } from "./contract.ts";
import { readPublicHistory } from "./history-reader.ts";

const bounds = { from: "2020-01-01T00:00:00.000Z", to: "2026-11-07T00:00:00.000Z" };
const context = (fetch: typeof globalThis.fetch, caller: string | undefined = "member") =>
  ({
    app: {
      accounts: { pool: { headers: () => ({ authorization: "Bearer fixture-pool-account" }) } },
    },
    user: caller === undefined ? undefined : { id: caller },
    signal: new AbortController().signal,
    fetch,
  }) as unknown as Parameters<typeof readPublicHistory>[0];

test("history uses the provisioned account and current caller, with encoded keyset pagination", async () => {
  const after = { timestamp: "2020-01-01T12:00:00.123456Z", id: "a".repeat(64) };
  for (const caller of ["manager", "member"]) {
    const page = { records: [{ id: "b".repeat(64), person: caller }], next: after };
    const ctx = context(async (input, init) => {
      const url = new URL(String(input));
      assert.equal(url.pathname, "/pool/v1/usage/history");
      assert.equal(url.searchParams.get("from"), bounds.from);
      assert.equal(url.searchParams.get("to"), bounds.to);
      assert.deepEqual(JSON.parse(url.searchParams.get("after")!), after);
      assert.deepEqual([...url.searchParams.keys()].sort(), ["after", "from", "to"]);
      const headers = new Headers(init?.headers);
      assert.equal(headers.get("authorization"), "Bearer fixture-pool-account");
      assert.equal(headers.get(callerHeader), caller);
      assert.equal(init?.method, "GET");
      assert.equal(init?.body, undefined);
      assert.equal(init?.signal, ctx.signal);
      return Response.json(page);
    }, caller);
    const input = { ...bounds, after, pool: "other-pool", caller: "other-person" };
    assert.deepEqual(await readPublicHistory(ctx, input), { ok: true, value: page });
  }
});

test("missing account refuses locally and an absent caller is never replaced by the pool owner", async () => {
  let calls = 0;
  const ctx = context(async (_input, init) => {
    calls++;
    assert.equal(new Headers(init?.headers).has(callerHeader), false);
    return Response.json(
      { error: "unauthorized", message: "Sign in to read model history." },
      { status: 403 },
    );
  });
  const anonymous = { ...ctx, user: undefined };
  assert.deepEqual(await readPublicHistory(anonymous, bounds), {
    ok: false,
    error: "unauthorized",
    message: "Sign in to read model history.",
  });
  const unlinked = { ...ctx, app: { accounts: {} } } as unknown as typeof ctx;
  const result = await readPublicHistory(unlinked, bounds);
  assert.equal(result.ok, false);
  assert.equal(calls, 1);
});

test("history retains authorization and query refusals and never turns failures into an empty page", async () => {
  for (const status of [400, 401, 403, 503]) {
    const failure = {
      error:
        status === 400 ? "invalid_query" : status === 503 ? "backend_unavailable" : "unauthorized",
      message: "Fixture refusal",
    };
    assert.deepEqual(
      await readPublicHistory(
        context(async () => Response.json(failure, { status })),
        bounds,
      ),
      { ok: false, ...failure },
    );
  }
  const malformed = await readPublicHistory(
    context(async () => new Response("Unavailable", { status: 502 })),
    bounds,
  );
  assert.equal(malformed.ok, false);
  await assert.rejects(
    readPublicHistory(
      context(async () => {
        throw new Error("offline");
      }),
      bounds,
    ),
    /offline/,
  );
});
