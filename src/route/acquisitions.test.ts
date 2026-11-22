import assert from "node:assert/strict";
import { test } from "node:test";
import { signEnvelope } from "../pool/token.ts";
import { routeAcquisitionPath, routeAcquisitionPrefix } from "./acquisition-contract.ts";
import { handleRouteAcquisition, type RouteGatewayRpc } from "./acquisitions.ts";
import { RouteGatewayCore } from "./gateway.ts";
import { gatewayDependencies } from "./test/gateway.ts";

const key = "a".repeat(64);
const previous = "b".repeat(64);
const routeId = "rt_" + "a".repeat(26);
const owner = "org/org-1/user/person-1";

function receiver(gateway: RouteGatewayRpc | undefined, now: () => number) {
  return async (body: unknown, signingKey = key) => {
    const envelope = await signEnvelope(signingKey, routeAcquisitionPrefix, body);
    const response = await handleRouteAcquisition(
      new Request(`https://pool.invalid${routeAcquisitionPath}`, {
        method: "POST",
        body: JSON.stringify({ envelope }),
      }),
      { signingKey: key, previousSigningKey: previous, gateway: () => gateway, now },
    );
    return { status: response.status, body: (await response.json()) as Record<string, unknown> };
  };
}

function setup() {
  const fixture = gatewayDependencies();
  const gateway = new RouteGatewayCore(fixture.deps);
  const send = receiver(gateway, fixture.deps.now);
  const at = fixture.deps.now();
  const window = { routeId, at, expiresAt: at + 25_000 };
  const session = (action: string, extra: object = {}, person = owner) => ({
    ...window,
    action,
    owner: person,
    ...extra,
  });
  const saved = (
    action: string,
    extra: object = {},
    account = "acct-1",
    organization = "org-1",
  ) => ({
    ...window,
    action,
    organization,
    account,
    ...extra,
  });
  return { ...fixture, gateway, send, session, saved };
}
const refused = { status: 403, body: { error: "route_not_permitted" } };

test("a join runs start, waiting, then connected with the tailnet name", async () => {
  const { send, session, container, deps } = setup();
  assert.deepEqual(await send(session("start", { app: "tailscale" })), {
    status: 200,
    body: { url: "https://login.example.invalid/a/test", expiresAt: deps.now() + 600_000 },
  });
  assert.deepEqual((await send(session("status"))).body, { state: "waiting" });
  container.approve();
  assert.deepEqual((await send(session("status"))).body, {
    state: "connected",
    tailnet: "example-tailnet",
  });
  assert.deepEqual(await send(session("start", { app: "tailscale" })), {
    status: 400,
    body: { error: "bad_request" },
  });
});

test("saved-account steps bind the first account and act on the route", async () => {
  const { send, session, saved, container, storage } = setup();
  await send(session("start", { app: "tailscale" }));
  container.approve();
  await send(session("status"));
  assert.deepEqual((await send(saved("exits"))).body, {
    exits: [
      { id: "n1", name: "home-exit", online: true, lastSeen: null },
      { id: "n2", name: "away-exit", online: false, lastSeen: Date.parse("2026-11-20T08:00:00Z") },
    ],
    selected: { exitId: null, whenDown: "stop" },
  });
  assert.equal((await storage.get<{ account: string }>("route-v1:meta"))?.account, "acct-1");
  const selected = (await send(saved("select", { exitId: "n1", whenDown: "direct" }))).body;
  assert.equal((selected.reading as { state: string }).state, "active");
  assert.deepEqual((await send(saved("exits"))).body.selected, {
    exitId: "n1",
    whenDown: "direct",
  });
  assert.equal(
    ((await send(saved("reading"))).body.reading as { exitName: string }).exitName,
    "home-exit",
  );
  assert.equal(((await send(saved("check"))).body.reading as { state: string }).state, "active");
  assert.deepEqual(await send(saved("reading", {}, "acct-2")), refused);
  assert.deepEqual(await send(saved("reading", {}, "acct-1", "org-2")), refused);
  assert.deepEqual((await send(saved("remove"))).body, {});
  assert.deepEqual((await send(saved("remove"))).body, {});
  assert.equal(container.logouts, 1);
  assert.equal(
    ((await send(saved("reading"))).body.reading as { state: string }).state,
    "needs_login",
  );
});

test("another person is refused at every sign-in step", async () => {
  const { send, session } = setup();
  await send(session("start", { app: "tailscale" }));
  const stranger = "org/org-1/user/person-2";
  for (const action of ["status", "cancel"])
    assert.deepEqual(await send(session(action, {}, stranger)), refused);
  assert.deepEqual(await send(session("start", { app: "tailscale" }, stranger)), refused);
  assert.deepEqual((await send(session("cancel"))).body, {});
});

test("bad signatures and windows are refused; malformed claims are bad requests", async () => {
  const { send, session, saved, deps } = setup();
  const bad = { status: 400, body: { error: "bad_request" } };
  assert.deepEqual(await send(session("status"), "c".repeat(64)), refused);
  assert.deepEqual(await send({ ...session("status"), expiresAt: deps.now() - 1 }), refused);
  assert.deepEqual(await send({ ...session("status"), expiresAt: deps.now() + 60_000 }), refused);
  assert.deepEqual(await send(session("launch")), bad);
  assert.deepEqual(await send({ ...session("status"), extra: true }), bad);
  assert.deepEqual(await send({ ...session("status"), routeId: "rt_SHORT" }), bad);
  assert.deepEqual(await send(session("status", {}, "person-1")), bad);
  assert.deepEqual(await send(saved("status")), bad);
  const response = await handleRouteAcquisition(
    new Request(`https://pool.invalid${routeAcquisitionPath}`, { method: "POST", body: "{}" }),
    { signingKey: key, previousSigningKey: undefined, gateway: () => undefined, now: deps.now },
  );
  assert.equal(response.status, 400);
  // A rotation keeps the previous key's requests valid.
  await send(session("start", { app: "tailscale" }));
  assert.equal((await send(session("status"), previous)).status, 200);
});

test("without the class every request reads unavailable", async () => {
  const { deps } = gatewayDependencies();
  const send = receiver(undefined, deps.now);
  const at = deps.now();
  assert.deepEqual(await send({ routeId, owner, at, expiresAt: at + 25_000, action: "status" }), {
    status: 503,
    body: { error: "route_gateway_unavailable" },
  });
});

test("signing in again is start on the same route: a fresh link, then connected, account kept", async () => {
  const { send, session, saved, container, storage } = setup();
  await send(session("start", { app: "tailscale" }));
  container.approve();
  await send(session("status"));
  await send(saved("select", { exitId: "n1", whenDown: "stop" }));
  assert.deepEqual((await send(saved("remove"))).body, {});
  const again = await send(session("start", { app: "tailscale" }));
  assert.equal(again.status, 200);
  assert.equal(again.body.url, "https://login.example.invalid/a/test");
  assert.deepEqual((await send(session("status"))).body, { state: "waiting" });
  container.approve();
  assert.deepEqual((await send(session("status"))).body, {
    state: "connected",
    tailnet: "example-tailnet",
  });
  assert.equal((await storage.get<{ account: string }>("route-v1:meta"))?.account, "acct-1");
  assert.equal((await send(saved("exits"))).status, 200);
});

test("a namespace that throws on lookup answers unavailable, not a server error", async () => {
  const { deps } = gatewayDependencies();
  const at = deps.now();
  const envelope = await signEnvelope(key, routeAcquisitionPrefix, {
    routeId,
    owner,
    at,
    expiresAt: at + 25_000,
    action: "status",
  });
  const response = await handleRouteAcquisition(
    new Request(`https://pool.invalid${routeAcquisitionPath}`, {
      method: "POST",
      body: JSON.stringify({ envelope }),
    }),
    {
      signingKey: key,
      previousSigningKey: undefined,
      gateway: () => {
        throw new Error("Jurisdiction restrictions are not implemented");
      },
      now: deps.now,
    },
  );
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { error: "route_gateway_unavailable" });
});
