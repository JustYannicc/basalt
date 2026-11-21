// The native approval page, driven as the person's browser drives it, against the real setup host,
// the real tools host and the real pool. A device approved for tools only never needs the pool, so
// the page must not dead-end on a pool read while the pool is down.
import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { DatabaseSync } from "node:sqlite";
import { test, type TestContext } from "node:test";
import { fixture } from "./native-device-fixture.ts";
import { control } from "../../apps/pool/control.ts";
import { fixture as poolFixture, pool } from "../../src/pool/test/computers.ts";
import { failureResponse } from "../../src/pool/json.ts";
import { handleSetup } from "../../src/setup/host.ts";
import {
  DeviceApprovalError,
  readDevicePools,
  readDeviceRequest,
  reviewDeviceDecision,
  type DeviceTransport,
} from "../../src/setup/native-device-api.ts";

// The tools host's origin, which the device request names. The pool fixture names the public site
// https://setup.example in the setup links it signs, so the setup host answers on that name.
const origin = "http://localhost:3000";
const site = "https://setup.example";
const outage = () => failureResponse(new Error("synthetic controller outage"));

/** The pool Worker's native control endpoint in an outage, as the tools host reaches it over HTTP. */
async function downControl(t: TestContext) {
  const server = createServer(async (incoming, outgoing) => {
    incoming.resume();
    const response = outage();
    outgoing.writeHead(response.status, { "content-type": "application/json" });
    outgoing.end(Buffer.from(await response.arrayBuffer()));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

/** The page's browser, signed in, with the site's setup host, tools host and pool behind it. */
async function page(t: TestContext) {
  const p = poolFixture();
  let setupDown = false;
  // SQL rows, as production reads them: the memory adapter returns fields a schema refuses.
  const db = new DatabaseSync(":memory:");
  t.after(() => db.close());
  const f = await fixture(undefined, undefined, db, {
    organizations: true,
    poolOrigin: await downControl(t),
  });
  t.after(() => f[Symbol.dispose]());
  // The person's own pool, as its organization's metadata points to it.
  const team = (
    await f.adapter.create<{ id: string }>({
      model: "organization",
      data: {
        name: "Tools",
        slug: "tools",
        createdAt: new Date(),
        metadata: JSON.stringify({ basaltPools: { [f.userId]: { app: pool.pool } } }),
      },
    })
  ).id;
  await f.adapter.create({
    model: "member",
    data: { organizationId: team, userId: f.userId, role: "owner", createdAt: new Date() },
  });
  const claims = { ...pool, owner: f.userId, organization: team };
  // The host signs its assertions with the real clock; the pool's clock follows it.
  const sync = () => p.advance(Date.now() - p.now());
  // The pool app's own computerContext query, which the tools host runs for the setup host.
  const query = {
    app: { accounts: { pool: { headers: () => ({}) } } },
    user: { id: f.userId },
    signal: new AbortController().signal,
    fetch: async (url: string) => {
      assert.equal(new URL(url).pathname, "/pool/v1/setup-context");
      if (setupDown) return outage();
      sync();
      return p.context(f.userId, claims);
    },
  } as unknown as Parameters<typeof control>[0];
  const app = `/api/organizations/${team}/apps/${pool.pool}`;
  const env = {
    POOL_APP_SIGNING_KEY: "ab".repeat(32),
    TOOLS_SERVICE: {
      fetch: async (request: Request) => {
        const { pathname, search } = new URL(request.url);
        if (pathname.startsWith("/api/auth/"))
          return f.handler(new Request(new URL(`${pathname}${search}`, origin), request));
        // The tools service's own record of who created the pool app.
        if (pathname === `${app}/access`)
          return Response.json({ creator: f.userId, audience: { kind: "private" } });
        if (pathname === `${app}/data/query`)
          return Response.json(await control(query, "/setup-context"));
        return Response.json({ error: "not_found" }, { status: 404 });
      },
    },
    POOL_SERVICE: {
      fetch: async (request: Request) => {
        if (setupDown) return outage();
        sync();
        return p.setup(request);
      },
    },
  };
  const paths: string[] = [];
  const browser: DeviceTransport = {
    origin,
    fetch: async (path, init) => {
      const setup = path.startsWith("/setup/");
      const url = new URL(path, setup ? site : origin);
      const headers = new Headers(init.headers);
      headers.set("cookie", f.cookies);
      if (init.method === "POST") headers.set("origin", url.origin);
      const call = { path: url.pathname };
      paths.push(call.path);
      const request = new Request(url, { ...init, headers });
      return setup ? handleSetup(request, env) : f.handler(request);
    },
  };
  /** The person's tools-only grant, read from its row. */
  const toolsGrant = async () => {
    const grants = await f.adapter.findMany<{ policy: string }>({
      model: "mcpGrant",
      where: [{ field: "userId", value: f.userId }],
    });
    const policies = grants
      .map((grant) => JSON.parse(grant.policy) as { models: boolean; toolsOrganization?: string })
      .filter((policy) => !policy.models);
    assert.equal(policies.length, 1);
    return policies[0]!;
  };
  return {
    f,
    team,
    browser,
    paths,
    toolsGrant,
    /** The pool's setup endpoints fail too, not only its native control. */
    down: () => {
      setupDown = true;
    },
  };
}

/** The value; a refusal fails the test with its message. */
async function settled<A>(promise: Promise<A>): Promise<A> {
  try {
    return await promise;
  } catch (error) {
    return assert.fail(`refused: ${error instanceof Error ? error.message : String(error)}`);
  }
}

const signal = () => new AbortController().signal;
const choice = { name: "Work laptop", pool: pool.pool, models: true, tools: true };

test("after the pool refuses a device with models, approving tools only reads nothing through it", async (t) => {
  const h = await page(t);
  const request = await settled(readDeviceRequest(h.f.user_code, signal(), h.browser));
  const held = await settled(readDevicePools(signal(), h.browser));
  assert.deepEqual(
    held.pools.map((entry) => entry.id),
    [pool.pool],
  );
  // The pool's control plane fails, so it cannot register a device with models.
  await assert.rejects(
    reviewDeviceDecision(h.f.user_code, request, signal(), choice, held, h.browser),
    (error: unknown) => error instanceof DeviceApprovalError && error.kind === "models-unavailable",
  );
  h.down();
  const before = h.paths.length;
  const retried = await settled(
    reviewDeviceDecision(
      h.f.user_code,
      request,
      signal(),
      { ...choice, models: false },
      held,
      h.browser,
    ),
  );
  assert.deepEqual(retried, { kind: "decided", status: "approved" });
  assert.deepEqual(
    h.paths.slice(before).filter((path) => path.startsWith("/setup/")),
    [],
    "the retry reuses the intent the page holds",
  );
  const policy = await h.toolsGrant();
  assert.equal(policy.toolsOrganization, h.team);
});

test("with the pool down before the page opens, the person can still approve tools only", async (t) => {
  const h = await page(t);
  h.down();
  const request = await settled(readDeviceRequest(h.f.user_code, signal(), h.browser));
  const held = await settled(readDevicePools(signal(), h.browser));
  assert.equal(held.toolsOnly, true);
  assert.deepEqual(held.pools, []);
  // Models need the pool, so they are not offered, and nothing is decided.
  await assert.rejects(
    reviewDeviceDecision(h.f.user_code, request, signal(), choice, held, h.browser),
    (error: unknown) => error instanceof DeviceApprovalError && error.kind === "models-unavailable",
  );
  const approved = await settled(
    reviewDeviceDecision(
      h.f.user_code,
      request,
      signal(),
      { ...choice, pool: "", models: false },
      held,
      h.browser,
    ),
  );
  assert.deepEqual(approved, { kind: "decided", status: "approved" });
  const policy = await h.toolsGrant();
  assert.equal(policy.toolsOrganization, h.team);
});
