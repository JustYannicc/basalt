import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { handleSetup, type SetupEnv } from "./host.ts";
import { readDevicePools } from "./native-device-api.ts";
import { fixture, owner, pool, signingKey } from "../pool/test/computers.ts";
import { signEnvelope } from "../pool/token.ts";

const origin = "https://setup.example";
const hostNow = Date.parse("2026-11-10T16:07:43Z");

function browser(t: TestContext, behindMs: number) {
  const p = fixture();
  p.advance(hostNow - behindMs - p.now());
  const calls: { path: string; status: number }[] = [];
  const cookies: (string | null)[] = [];
  const env: SetupEnv = {
    POOL_APP_SIGNING_KEY: signingKey,
    TOOLS_SERVICE: {
      async fetch(request) {
        const path = new URL(request.url).pathname;
        if (path === "/api/auth/get-session") {
          cookies.push(request.headers.get("cookie"));
          return Response.json({ user: { id: owner, emailVerified: true } });
        }
        if (path === "/api/auth/organization/list")
          return Response.json([
            {
              id: pool.organization,
              metadata: { basaltPools: { [owner]: { app: pool.pool } } },
            },
          ]);
        if (path.endsWith("/access")) return Response.json({ creator: owner });
        if (path.endsWith("/data/query"))
          return Response.json({ ok: true, value: await (await p.context(owner)).json() });
        throw new Error(`Unexpected tools path: ${path}`);
      },
    },
    POOL_SERVICE: {
      async fetch(request) {
        const response = await p.setup(request);
        calls.push({ path: new URL(request.url).pathname, status: response.status });
        return response;
      },
    },
  };
  t.mock.method(globalThis, "fetch", (path: string) =>
    handleSetup(
      new Request(new URL(path, origin), {
        headers: { cookie: "executor-hosted.session_token=synthetic" },
      }),
      env,
    ),
  );
  return { p, calls, cookies, load: () => readDevicePools(new AbortController().signal) };
}

test("device pools load first time when the pool clock trails the setup host", async (t) => {
  t.mock.method(Date, "now", () => hostNow);
  for (const behindMs of [0, 1, 50, 5_000]) {
    await t.test(`${behindMs} ms behind`, async (t) => {
      const f = browser(t, behindMs);
      const result = await f.load();
      assert.deepEqual(
        result.pools.map(({ id }) => id),
        [pool.pool],
      );
      assert.deepEqual(f.calls, [
        { path: "/__setup/v1/validate", status: 200 },
        { path: "/__setup/v1/computers", status: 200 },
      ]);
      assert.deepEqual(Object.keys(await f.p.registry()), []);
    });
  }
});

test("first load and a same-session retry both work without refreshing the session", async (t) => {
  t.mock.method(Date, "now", () => hostNow);
  const f = browser(t, 50);
  const first = await f.load().catch((error: unknown) => error);
  f.p.advance(50);
  const retry = await f.load();
  assert.ok(!(first instanceof Error), "first load must not show a false sign-in error");
  assert.ok(first && typeof first === "object" && "pools" in first);
  assert.deepEqual(first.pools, retry.pools);
  assert.equal(f.calls.length, 4);
  assert.ok(f.calls.every((call) => call.status === 200));
  assert.deepEqual(f.cookies, Array(4).fill("executor-hosted.session_token=synthetic"));
});

test("the pool still refuses expired and overlong signed setup assertions", async () => {
  const p = fixture();
  const intent = await p.intent(owner);
  for (const expiresAt of [p.now(), p.now() + 30_001]) {
    const envelope = await signEnvelope(signingKey, "sbs1", {
      action: "validate",
      user: owner,
      intent,
      expiresAt,
    });
    const response = await p.setup(
      new Request(`${origin}/__setup/v1/validate`, {
        method: "POST",
        body: JSON.stringify({ envelope }),
      }),
    );
    assert.equal(response.status, 401);
    assert.equal((await response.json()).message, "A valid setup host assertion is required.");
  }
});
