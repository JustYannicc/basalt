import assert from "node:assert/strict";
import { test } from "node:test";
import { RouteGatewayCore } from "./gateway.ts";
import { gatewayDependencies } from "./test/gateway.ts";
import { sealRouteState, openRouteState } from "./state.ts";

const routeId = "rt_" + "a".repeat(26);
const owner = "org/org-1/user/person-1";
const other = "org/org-1/user/person-2";
const caller = { routeId, owner };

async function created(overrides = {}) {
  const fixture = gatewayDependencies(overrides);
  const gateway = new RouteGatewayCore(fixture.deps);
  await gateway.create({ routeId, owner, app: "tailscale" });
  return { ...fixture, gateway };
}

async function refusedWith(work: Promise<unknown>, reason: string) {
  await assert.rejects(work, (error: Error) => error.message === reason);
}

test("create is idempotent for its owner and refuses anyone else", async () => {
  const { gateway } = await created();
  assert.deepEqual(await gateway.create({ routeId, owner, app: "tailscale" }), {});
  await refusedWith(
    gateway.create({ routeId, owner: other, app: "tailscale" }),
    "route_not_permitted",
  );
  await refusedWith(gateway.create({ routeId, owner, app: "other" }), "route_not_permitted");
  await refusedWith(
    gateway.create({ routeId: "rt_" + "b".repeat(26), owner, app: "tailscale" }),
    "route_not_permitted",
  );
});

test("an object addressed by one route refuses to become another", async () => {
  const { deps } = gatewayDependencies({ name: "rt_" + "b".repeat(26) });
  await refusedWith(
    new RouteGatewayCore(deps).create({ routeId, owner, app: "tailscale" }),
    "route_not_permitted",
  );
});

test("every call names its route and owner, and a stranger is refused before compute starts", async () => {
  const { gateway, container } = await created();
  const stranger = { routeId, owner: other };
  for (const work of [
    gateway.login(stranger),
    gateway.joinStatus(stranger),
    gateway.exits(stranger),
    gateway.select(stranger, { exitId: "n1", whenDown: "stop" }),
    gateway.reading(stranger),
    gateway.disconnect(stranger),
    gateway.openTunnel({ owner: other }),
  ])
    await refusedWith(work, "route_not_permitted");
  assert.equal(container.running, false);
  const fresh = new RouteGatewayCore(gatewayDependencies().deps);
  await refusedWith(fresh.reading(caller), "route_not_permitted");
  await refusedWith(fresh.openTunnel({ owner }), "route_not_permitted");
});

test("a saved account's first step binds it; other accounts and organizations are refused", async () => {
  const { gateway, storage } = await created();
  const saved = { routeId, organization: "org-1", account: "acct-1" };
  assert.equal((await gateway.reading(saved)).state, "needs_login");
  assert.equal((await gateway.reading(saved)).state, "needs_login");
  assert.equal((await storage.get<{ account: string }>("route-v1:meta"))?.account, "acct-1");
  await refusedWith(gateway.reading({ ...saved, account: "acct-2" }), "route_not_permitted");
  await refusedWith(gateway.reading({ ...saved, organization: "org-2" }), "route_not_permitted");
  await refusedWith(
    gateway.reading({ routeId: "rt_" + "b".repeat(26), organization: "org-1", account: "acct-1" }),
    "route_not_permitted",
  );
});

test("login polls every 2 s and persists the sealed identity once the person approves", async () => {
  const { gateway, container, storage, advance, deps } = await created();
  assert.deepEqual(await gateway.login(caller), {
    url: "https://login.example.invalid/a/test",
    expiresAt: deps.now() + 10 * 60_000,
  });
  assert.deepEqual(await gateway.joinStatus(caller), { state: "waiting" });
  assert.deepEqual(container.starts, [null]);
  assert.equal(storage.alarm, deps.now() + 2_000);
  advance(2_000);
  await gateway.alarm();
  assert.equal(storage.alarm, deps.now() + 2_000);
  assert.equal(await storage.get("route-v1:state"), undefined);
  container.approve();
  advance(2_000);
  await gateway.alarm();
  const stored = await storage.get<{ sealed: { iv: number[]; bytes: number[] }; revision: number }>(
    "route-v1:state",
  );
  assert.ok(stored);
  assert.equal(stored.revision, 1);
  assert.equal(JSON.stringify(stored).includes("node-state-after-login"), false);
  assert.equal(
    (await openRouteState(deps.secret, routeId, stored.sealed)).state,
    "node-state-after-login",
  );
  // No selection yet, and the login finished: nothing keeps polling.
  assert.equal(storage.alarm, null);
  assert.deepEqual(await gateway.joinStatus(caller), {
    state: "connected",
    tailnet: "example-tailnet",
  });
  assert.deepEqual(await gateway.login(caller), { state: "ready" });
});

test("a login nobody approves stops polling after 10 minutes", async () => {
  const { gateway, storage, advance } = await created();
  await gateway.login(caller);
  advance(10 * 60_000);
  await gateway.alarm();
  assert.equal(storage.alarm, null);
  assert.deepEqual(await gateway.joinStatus(caller), {
    state: "failed",
    reason: "route_needs_login",
  });
});

test("select returns the reading, keeps the route warm and polls every 30 s", async () => {
  const { gateway, container, storage, deps } = await created();
  await gateway.login(caller);
  container.approve();
  const reading = await gateway.select(caller, { exitId: "n1", whenDown: "stop" });
  assert.deepEqual(reading, {
    state: "active",
    reason: null,
    exitName: "home-exit",
    tailnet: "example-tailnet",
    deviceName: "signalbox-route",
    deviceId: "node-1",
    keyExpiry: Date.parse("2027-05-21T00:00:00Z"),
    path: "relay",
    relayRegion: "fra",
    checkedAt: deps.now(),
    since: deps.now(),
    whenDown: "stop",
  });
  assert.equal(storage.alarm, deps.now() + 30_000);
  await gateway.alarm();
  assert.ok(container.inactivity.length > 0);
  assert.deepEqual(await gateway.exits(caller), {
    exits: [
      { id: "n1", name: "home-exit", online: true, lastSeen: null },
      { id: "n2", name: "away-exit", online: false, lastSeen: Date.parse("2026-11-20T08:00:00Z") },
    ],
    selected: { exitId: "n1", whenDown: "stop" },
  });
  const off = await gateway.select(caller, { exitId: null, whenDown: "stop" });
  assert.equal(off.state, "off");
  assert.equal(off.reason, "route_off");
});

test("a restarted container gets the stored identity and selection before anything else", async () => {
  const { gateway, container, advance } = await created();
  await gateway.login(caller);
  container.approve();
  await gateway.select(caller, { exitId: "n1", whenDown: "direct" });
  container.crash();
  advance(30_000);
  await gateway.alarm();
  assert.deepEqual(container.starts, [null, "node-state-after-login"]);
  assert.deepEqual(container.selects.at(-1), { exit_id: "n1", when_down: "direct" });
  const reading = await gateway.reading(caller);
  assert.equal(reading.state, "active");
  assert.equal(reading.whenDown, "direct");
});

test("a key rotation keeps the device signed in and reseals under the current key", async () => {
  const previous = "b".repeat(64);
  const { deps, storage, container } = gatewayDependencies({ previousSecret: previous });
  const gateway = new RouteGatewayCore(deps);
  await gateway.create({ routeId, owner, app: "tailscale" });
  await storage.put("route-v1:state", {
    sealed: await sealRouteState(previous, routeId, "old-key-state"),
    bootId: "boot-0",
    revision: 1,
  });
  await gateway.select(caller, { exitId: "n1", whenDown: "stop" });
  assert.deepEqual(container.starts, ["old-key-state"]);
  const stored = await storage.get<{ sealed: { iv: number[]; bytes: number[] } }>("route-v1:state");
  assert.equal((await openRouteState(deps.secret, routeId, stored!.sealed)).state, "old-key-state");
});

test("a state no key opens starts a logged-out node, never a crash", async () => {
  const { gateway, storage, container } = await created();
  await storage.put("route-v1:state", {
    sealed: await sealRouteState("c".repeat(64), routeId, "lost"),
    bootId: "boot-0",
    revision: 1,
  });
  const reading = await gateway.select(caller, { exitId: "n1", whenDown: "stop" });
  assert.deepEqual(container.starts, [null]);
  assert.equal(reading.state, "needs_login");
  assert.equal(reading.reason, "route_needs_login");
});

test("only crossing into or out of down emits, with reason codes and no names", async () => {
  const { gateway, container, events, advance } = await created();
  await gateway.login(caller);
  container.approve();
  await gateway.select(caller, { exitId: "n1", whenDown: "stop" });
  assert.equal(events.length, 0);
  container.reachable = false;
  advance(30_000);
  await gateway.alarm();
  advance(30_000);
  await gateway.alarm();
  assert.deepEqual(events, [
    { event: "route.reading.changed", routeId, state: "down", reason: "route_gateway_unavailable" },
  ]);
  container.reachable = true;
  advance(30_000);
  await gateway.alarm();
  assert.deepEqual(events.at(-1), {
    event: "route.reading.changed",
    routeId,
    state: "active",
    reason: null,
  });
  assert.equal(events.length, 2);
  assert.equal(JSON.stringify(events).includes("home-exit"), false);
  assert.equal(JSON.stringify(events).includes("example-tailnet"), false);
});

test("an unreachable gateway reads down, and a never-joined route reads without starting compute", async () => {
  const { gateway, container } = await created();
  const idle = await gateway.reading(caller);
  assert.equal(idle.state, "needs_login");
  assert.equal(container.running, false);
  await gateway.select(caller, { exitId: "n1", whenDown: "stop" });
  container.reachable = false;
  const reading = await gateway.reading(caller);
  assert.equal(reading.state, "down");
  assert.equal(reading.reason, "route_gateway_unavailable");
});

test("disconnect logs the device out, forgets its identity and stops the container", async () => {
  const { gateway, container, storage } = await created();
  await gateway.login(caller);
  container.approve();
  await gateway.select(caller, { exitId: "n1", whenDown: "stop" });
  assert.deepEqual(await gateway.disconnect(caller), {});
  assert.equal(container.logouts, 1);
  assert.equal(container.running, false);
  assert.equal(await storage.get("route-v1:state"), undefined);
  assert.equal(await storage.get("route-v1:selection"), undefined);
  assert.equal(storage.alarm, null);
  assert.equal((await gateway.reading(caller)).state, "needs_login");
});

test("a tunnel opens to the SOCKS port for its owner and refuses when the gateway is gone", async () => {
  const { gateway, container } = await joined();
  const socket = await gateway.openTunnel({ owner });
  assert.equal(container.running, true);
  await socket.close();
  container.reachable = false;
  await refusedWith(gateway.openTunnel({ owner }), "route_gateway_unavailable");
});

test("the node state and login link never reach a log line", async () => {
  const lines: string[] = [];
  const original = console.log;
  console.log = (...values: unknown[]) => lines.push(values.join(" "));
  try {
    const { gateway, container, advance } = await created();
    await gateway.login(caller);
    container.approve();
    advance(2_000);
    await gateway.alarm();
    container.reachable = false;
    await gateway.disconnect(caller);
  } finally {
    console.log = original;
  }
  const logged = lines.join("\n");
  assert.equal(logged.includes("node-state-after-login"), false);
  assert.equal(logged.includes("login.example.invalid"), false);
});

/** Lets every other call in flight run as far as it can before a held request is released. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

async function joined() {
  const fixture = await created();
  await fixture.gateway.login(caller);
  fixture.container.approve();
  return fixture;
}

test("a select the gateway lost at boot is re-sent, so the route never silently reads off", async () => {
  const { gateway, container, advance } = await joined();
  await gateway.select(caller, { exitId: "n1", whenDown: "direct" });
  container.crash();
  container.failSelects = 1;
  advance(30_000);
  await gateway.alarm();
  advance(30_000);
  await gateway.alarm();
  const reading = await gateway.reading(caller);
  assert.equal(reading.state, "active");
  assert.equal(reading.whenDown, "direct");
  assert.deepEqual(container.selects.at(-1), { exit_id: "n1", when_down: "direct" });
});

test("a select that never lands is refused and leaves the previous selection in force", async () => {
  const { gateway, container, storage } = await joined();
  await gateway.select(caller, { exitId: "n1", whenDown: "stop" });
  container.failSelects = 1;
  await refusedWith(
    gateway.select(caller, { exitId: "n2", whenDown: "direct" }),
    "route_gateway_unavailable",
  );
  assert.deepEqual(await storage.get("route-v1:selection"), { exitId: "n1", whenDown: "stop" });
  assert.equal((await gateway.reading(caller)).whenDown, "stop");
});

test("switching a route off stops warming and polling, and never restarts its gateway", async () => {
  const { gateway, container, storage, advance } = await joined();
  await gateway.select(caller, { exitId: "n1", whenDown: "stop" });
  const off = await gateway.select(caller, { exitId: null, whenDown: "stop" });
  assert.equal(off.state, "off");
  assert.equal(storage.alarm, null);
  container.crash();
  const warmed = container.inactivity.length;
  advance(30_000);
  await gateway.alarm();
  const reading = await gateway.reading(caller);
  assert.equal(reading.state, "off");
  assert.equal(container.running, false);
  assert.equal(container.inactivity.length, warmed);
  // Switching back on restores the identity and the new selection together.
  assert.equal((await gateway.select(caller, { exitId: "n1", whenDown: "stop" })).state, "active");
  assert.deepEqual(container.starts, [null, "node-state-after-login"]);
});

test("a tunnel to a disconnected route starts no compute", async () => {
  const { gateway, container } = await joined();
  await gateway.select(caller, { exitId: "n1", whenDown: "stop" });
  await gateway.disconnect(caller);
  const starts = container.starts.length;
  await refusedWith(gateway.openTunnel({ owner }), "route_gateway_unavailable");
  assert.equal(container.running, false);
  assert.equal(container.starts.length, starts);
});

test("since holds while the state holds and restarts when it changes", async () => {
  const { gateway, container, advance, deps } = await joined();
  const first = await gateway.select(caller, { exitId: "n1", whenDown: "stop" });
  advance(30_000);
  await gateway.alarm();
  assert.equal((await gateway.reading(caller)).since, first.since);
  container.reachable = false;
  advance(30_000);
  const down = await gateway.reading(caller);
  assert.equal(down.state, "down");
  assert.equal(down.since, deps.now());
});

test("a cold or unreachable route keeps its device id, names and key expiry while its identity lasts", async () => {
  const { gateway, container } = await joined();
  await gateway.select(caller, { exitId: "n1", whenDown: "stop" });
  await gateway.select(caller, { exitId: null, whenDown: "stop" });
  container.crash();
  const cold = await gateway.reading(caller);
  assert.equal(cold.state, "off");
  assert.equal(container.running, false);
  assert.deepEqual(
    [cold.deviceId, cold.deviceName, cold.tailnet],
    ["node-1", "signalbox-route", "example-tailnet"],
  );
  assert.equal(cold.keyExpiry, Date.parse("2027-05-21T00:00:00Z"));
  await gateway.disconnect(caller);
  const gone = await gateway.reading(caller);
  assert.deepEqual([gone.deviceId, gone.tailnet], [null, null]);
});

test("overlapping selects apply in order, and a failed one never reverts over a newer choice", async () => {
  const { gateway, container, storage, advance } = await joined();
  await gateway.select(caller, { exitId: "n1", whenDown: "stop" });
  container.failSelects = 1;
  const [second, third] = await Promise.allSettled([
    gateway.select(caller, { exitId: "n2", whenDown: "stop" }),
    gateway.select(caller, { exitId: "n3", whenDown: "stop" }),
  ]);
  assert.equal(second.status, "rejected");
  assert.equal(third.status, "fulfilled");
  assert.deepEqual(await storage.get("route-v1:selection"), { exitId: "n3", whenDown: "stop" });
  advance(30_000);
  await gateway.alarm();
  assert.deepEqual(container.selects.at(-1), { exit_id: "n3", when_down: "stop" });
});

test("selects that all fail during a cold start leave the stored selection as it was", async () => {
  const { gateway, container, storage } = await joined();
  await gateway.select(caller, { exitId: "n1", whenDown: "stop" });
  container.crash();
  container.reachable = false;
  const results = await Promise.allSettled([
    gateway.select(caller, { exitId: "n2", whenDown: "stop" }),
    gateway.select(caller, { exitId: "n3", whenDown: "stop" }),
  ]);
  assert.deepEqual(
    results.map((result) => result.status),
    ["rejected", "rejected"],
  );
  assert.deepEqual(await storage.get("route-v1:selection"), { exitId: "n1", whenDown: "stop" });
});

test("switching off succeeds during an outage and never starts compute", async () => {
  const { gateway, container, storage } = await joined();
  await gateway.select(caller, { exitId: "n1", whenDown: "stop" });
  container.reachable = false;
  const off = await gateway.select(caller, { exitId: null, whenDown: "stop" });
  assert.equal(off.state, "off");
  assert.deepEqual(await storage.get("route-v1:selection"), { exitId: null, whenDown: "stop" });
  assert.equal(storage.alarm, null);
  container.crash();
  container.reachable = true;
  const starts = container.starts.length;
  assert.equal((await gateway.select(caller, { exitId: null, whenDown: "stop" })).state, "off");
  assert.equal(container.starts.length, starts);
  assert.equal(container.running, false);
});

test("a signed-out node whose route is off reads as needing a sign-in, not connected", async () => {
  const { gateway, container } = await joined();
  container.offFirst = true;
  await gateway.select(caller, { exitId: null, whenDown: "stop" });
  container.crash();
  // Sign in again without Disconnect: the old seal is still stored, but the node lost its key.
  container.forgetState = true;
  await gateway.login(caller);
  const reading = await gateway.reading(caller);
  assert.equal(reading.state, "needs_login");
  assert.deepEqual(await gateway.joinStatus(caller), { state: "waiting" });
  container.approve();
  assert.deepEqual(await gateway.joinStatus(caller), {
    state: "connected",
    tailnet: "example-tailnet",
  });
});

test("a select failing after a disconnect never brings the deleted selection back", async () => {
  const { gateway, container, storage } = await joined();
  await gateway.select(caller, { exitId: "n1", whenDown: "stop" });
  const held = container.hold("/select");
  const choosing = gateway.select(caller, { exitId: "n2", whenDown: "stop" });
  await held.reached;
  const leaving = gateway.disconnect(caller);
  await settle();
  held.release();
  // Whichever way the select ends, the disconnect after it has the last word.
  await choosing.catch(() => {});
  await leaving;
  assert.equal(await storage.get("route-v1:selection"), undefined);
  assert.equal(await storage.get("route-v1:state"), undefined);
  const starts = container.starts.length;
  assert.equal((await gateway.reading(caller)).state, "needs_login");
  assert.equal(container.starts.length, starts);
});

test("an identity read in flight during a disconnect is never saved again", async () => {
  const { gateway, container, storage } = await joined();
  await gateway.select(caller, { exitId: "n1", whenDown: "stop" });
  container.crash();
  const held = container.hold("/state", "after");
  const reading = gateway.reading(caller);
  await held.reached;
  const leaving = gateway.disconnect(caller);
  await settle();
  held.release();
  await reading;
  await leaving;
  assert.equal(await storage.get("route-v1:state"), undefined);
  assert.deepEqual(await gateway.joinStatus(caller), {
    state: "failed",
    reason: "route_needs_login",
  });
  await assert.rejects(
    gateway.openTunnel({ owner }),
    (error: Error) => error.message === "route_gateway_unavailable",
  );
});

test("cancelling during a sign-in leaves no poll and no compute", async () => {
  const { gateway, container, storage } = await created();
  const held = container.hold("/login", "after");
  const signing = gateway.login(caller);
  await held.reached;
  const leaving = gateway.disconnect(caller);
  await settle();
  held.release();
  // The cancel overtook it, so the sign-in is refused rather than left half-armed.
  await assert.rejects(signing, (error: Error) => error.message === "route_gateway_unavailable");
  await leaving;
  assert.equal(await storage.get("route-v1:login-until"), undefined);
  assert.equal(storage.alarm, null);
  assert.equal(container.running, false);
});

test("switching off during a boot leaves the gateway off, not on the old exit", async () => {
  const { gateway, container } = await joined();
  await gateway.select(caller, { exitId: "n1", whenDown: "stop" });
  container.crash();
  const held = container.hold("/select");
  const tunnel = gateway.openTunnel({ owner });
  await held.reached;
  const off = gateway.select(caller, { exitId: null, whenDown: "stop" });
  await settle();
  held.release();
  // Switching off does not wait for the start: it stops the starting gateway, so the tunnel it
  // was starting for is refused and nothing is left routing through the old exit.
  await tunnel.then(
    (socket) => socket.close(),
    () => {},
  );
  assert.equal((await off).state, "off");
  assert.equal(container.running, false);
});

test("a switch-off the running gateway misses stops it, so it cannot keep routing", async () => {
  const { gateway, container } = await joined();
  await gateway.select(caller, { exitId: "n1", whenDown: "stop" });
  container.failSelects = 1;
  assert.equal((await gateway.select(caller, { exitId: null, whenDown: "stop" })).state, "off");
  assert.equal(container.running, false);
});

test("a failed identity read right after approval keeps the sign-in waiting, not failed", async () => {
  const { gateway, container } = await created();
  await gateway.login(caller);
  container.approve();
  container.failStates = 1;
  assert.deepEqual(await gateway.joinStatus(caller), { state: "waiting" });
  assert.deepEqual(await gateway.joinStatus(caller), {
    state: "connected",
    tailnet: "example-tailnet",
  });
});

test("switching off answers at once while an outage refresh is stuck starting the gateway", async () => {
  const { gateway, container, storage } = await joined();
  await gateway.select(caller, { exitId: "n1", whenDown: "stop" });
  container.crash();
  const held = container.hold("/status");
  const alarm = gateway.alarm();
  await held.reached;
  const off = gateway.select(caller, { exitId: null, whenDown: "stop" });
  const answered = await Promise.race([off.then(() => true), settle().then(() => false)]);
  assert.equal(answered, true);
  assert.equal((await off).state, "off");
  held.release();
  await alarm;
  assert.deepEqual(await storage.get("route-v1:selection"), { exitId: null, whenDown: "stop" });
  assert.equal(container.running, false);
});

test("readings during one outage share one start attempt", async () => {
  const { gateway, container } = await joined();
  await gateway.select(caller, { exitId: "n1", whenDown: "stop" });
  container.crash();
  const held = container.hold("/status");
  const reads = [gateway.alarm(), gateway.reading(caller), gateway.reading(caller)];
  await held.reached;
  held.release();
  await Promise.all(reads);
  assert.deepEqual(container.starts, [null, "node-state-after-login"]);
});

test("a tunnel never restarts a switched-off, stopped gateway", async () => {
  const { gateway, container } = await joined();
  await gateway.select(caller, { exitId: "n1", whenDown: "stop" });
  await gateway.select(caller, { exitId: null, whenDown: "stop" });
  container.crash();
  const starts = container.starts.length;
  await refusedWith(gateway.openTunnel({ owner }), "route_gateway_unavailable");
  assert.equal(container.starts.length, starts);
  assert.equal(container.running, false);
});

test("a malformed caller is refused with the reason code, never schema text", async () => {
  const { gateway } = await created();
  for (const input of [
    { routeId, owner: "person-1" },
    { routeId, owner, extra: true },
    { routeId },
    "not an object",
  ])
    await refusedWith(gateway.reading(input), "route_not_permitted");
  await refusedWith(gateway.select(caller, { exitId: 7, whenDown: "stop" }), "route_not_permitted");
  await refusedWith(gateway.create({ routeId, owner }), "route_not_permitted");
});

test("listing exits on a route with no identity starts no node", async () => {
  const { gateway, container } = await created();
  await refusedWith(gateway.exits(caller), "route_needs_login");
  assert.equal(container.running, false);
  assert.deepEqual(container.starts, []);
});
