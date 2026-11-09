import assert from "node:assert/strict";
import { test } from "node:test";
import { forwardPoolRequest } from "./forward.worker.ts";
import { NativeMemberships } from "./membership.ts";
import { PoolLifecycle } from "./lifecycle.ts";
import { RuntimeProtection } from "./runtime-protection.ts";
import {
  membershipGraceFixture,
  membershipSigningKey,
} from "../../scripts/pool-tests/membership-grace-fixture.ts";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function fixture() {
  const f = membershipGraceFixture();
  const memberships = new NativeMemberships(f.dependencies);
  await memberships.ensure("pool", "organization");
  await f.dependencies.storage.put("revision", "fixture");
  await f.dependencies.storage.put("ready-revision", "fixture");
  const status = {
    boot_id: "fixture",
    started_at: "2026-11-09T00:00:00Z",
    policyLeaseUntil: 1_500,
  };
  const pulse = deferred();
  const background: Promise<unknown>[] = [];
  const protection = new RuntimeProtection(f.streams, {
    check: async () => status,
    defer: (work) => {
      background.push(work);
    },
    unavailable: () => assert.fail("fixture plugin remains healthy"),
    now: () => 0,
    pause: () => ({ promise: pulse.promise, cancel() {} }),
  });
  const lifecycle = new PoolLifecycle(
    {
      running: () => true,
      start: () => assert.fail("the fixture is already running"),
      stop: async () => assert.fail("the fixture revision is unchanged"),
      keepAlive: async () => {},
      status: async () => status,
    },
    {
      ...f.dependencies.storage,
      getAlarm: async () => null,
      setAlarm: async () => {},
    },
    "fixture",
  );
  const dispatches: { method: string; body: string }[] = [];
  const forward = (request: Request) =>
    forwardPoolRequest(request, 8317, {
      appModel: { pool: "pool", person: "person" },
      env: { POOL_APP_SIGNING_KEY: membershipSigningKey },
      computers: {
        nativeModel: async () => {
          throw new Error("no device credential in this fixture");
        },
        observeUsage: async () => {},
      },
      memberships,
      streams: f.streams,
      lifecycle: Promise.resolve(lifecycle),
      protection,
      fetch: async (outbound) => {
        dispatches.push({ method: outbound.method, body: await outbound.text() });
        return Response.json({ ok: true });
      },
      defer: (work) => {
        background.push(work);
      },
    });
  return {
    ...f,
    memberships,
    forward,
    dispatches,
    finish: async () => {
      f.streams.abortAll();
      pulse.resolve();
      await Promise.all(background);
    },
  };
}

test("revocation during assertion signing cannot register a late stream and dispatch the old revision", async (t) => {
  const f = await fixture();
  const signing = deferred(),
    resume = deferred();
  const sign = crypto.subtle.sign.bind(crypto.subtle);
  let hold = true;
  t.mock.method(crypto.subtle, "sign", async (...args: Parameters<typeof crypto.subtle.sign>) => {
    if (hold) {
      hold = false;
      signing.resolve();
      await resume.promise;
    }
    return sign(...args);
  });
  let response: Response | undefined;
  t.after(async () => {
    resume.resolve();
    await response?.body?.cancel();
    await f.finish();
  });
  const pending = f.forward(new Request("https://pool.invalid/v1/models"));
  await signing.promise;
  f.fault("install400");
  await assert.rejects(f.reserve(f.memberships));
  resume.resolve();
  response = await pending;
  assert.equal(response.status, 503);
  assert.equal(f.dispatches.length, 0);
  assert.equal(f.streams.active, 0);
  await assert.rejects(f.memberships.authority("pool"), /refreshing/);
  const refused = await f.forward(new Request("https://pool.invalid/v1/models"));
  assert.equal(refused.status, 503);
  await refused.body?.cancel();
  assert.equal(f.dispatches.length, 0);
  assert.equal(f.streams.active, 0);
  f.fault("none");
  await f.memberships.ensure("pool", "organization");
  const recovered = await f.forward(new Request("https://pool.invalid/v1/models"));
  assert.equal(recovered.status, 200);
  assert.deepEqual(await recovered.json(), { ok: true });
  assert.equal(f.dispatches.length, 1);
});

test("failed assertion signing releases admission without dispatching a request", async (t) => {
  const f = await fixture();
  t.after(f.finish);
  t.mock.method(crypto.subtle, "sign", async () => {
    throw new Error("fixture signing failed");
  });
  const response = await f.forward(new Request("https://pool.invalid/v1/models"));
  assert.equal(response.status, 503);
  await response.body?.cancel();
  assert.equal(f.dispatches.length, 0);
  assert.equal(f.streams.active, 0);
});

test("model admission preserves a POST body and releases its stream after the response", async (t) => {
  const f = await fixture();
  t.after(f.finish);
  const body = JSON.stringify({ model: "fixture", input: "fixture-only" });
  const response = await f.forward(
    new Request("https://pool.invalid/v1/responses", {
      method: "POST",
      body,
      headers: { "content-type": "application/json" },
    }),
  );
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true });
  assert.deepEqual(f.dispatches, [{ method: "POST", body }]);
  assert.equal(f.streams.active, 0);
});
