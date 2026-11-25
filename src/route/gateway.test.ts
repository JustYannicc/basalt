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
  const { gateway, storage, container, advance } = await created();
  await gateway.login(caller);
  advance(10 * 60_000);
  await gateway.alarm();
  assert.equal(storage.alarm, null);
  // Its node is logged out and stopped, so a late approval leaves no device behind.
  assert.equal(container.logouts, 1);
  assert.equal(container.running, false);
  assert.deepEqual(await gateway.joinStatus(caller), {
    state: "failed",
    reason: "route_needs_login",
  });
});

test("select returns the reading, keeps the route warm and polls every 30 s", async () => {
  const { gateway, container, storage, deps } = await created();
  await gateway.login(caller);
  container.approve();
  await gateway.joinStatus(caller);
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
  await gateway.joinStatus(caller);
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

test("a state no key opens is forgotten, never a crash, and asks for a new sign-in", async () => {
  const { gateway, storage, container } = await created();
  await storage.put("route-v1:state", {
    sealed: await sealRouteState("c".repeat(64), routeId, "lost"),
    bootId: "boot-0",
    revision: 1,
  });
  await refusedWith(
    gateway.select(caller, { exitId: "n1", whenDown: "stop" }),
    "route_needs_login",
  );
  assert.deepEqual(container.starts, []);
  assert.equal(await storage.get("route-v1:state"), undefined);
  assert.deepEqual(await gateway.joinStatus(caller), {
    state: "failed",
    reason: "route_needs_login",
  });
});

test("only crossing into or out of down emits, with reason codes and no names", async () => {
  const { gateway, container, events, advance } = await created();
  await gateway.login(caller);
  container.approve();
  await gateway.joinStatus(caller);
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
  // Choosing an exit before any sign-in is refused without starting a node.
  await refusedWith(
    gateway.select(caller, { exitId: "n1", whenDown: "stop" }),
    "route_needs_login",
  );
  assert.equal(container.running, false);
  await gateway.login(caller);
  container.approve();
  await gateway.joinStatus(caller);
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
  await gateway.joinStatus(caller);
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
  await refusedWith(gateway.openTunnel({ owner }), "route_gateway_unavailable");
  await gateway.select(caller, { exitId: "n1", whenDown: "stop" });
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

/** Signed in as the driver sees it: approved, then one status poll seals the identity. */
async function joined() {
  const fixture = await created();
  await fixture.gateway.login(caller);
  fixture.container.approve();
  await fixture.gateway.joinStatus(caller);
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

test("a refresh queued behind a disconnect reads what the disconnect left, with no down event", async () => {
  const { gateway, container, events } = await joined();
  await gateway.select(caller, { exitId: "n1", whenDown: "stop" });
  const held = container.hold("/logout", "after");
  const leaving = gateway.disconnect(caller);
  await held.reached;
  const reading = gateway.reading(caller);
  await settle();
  held.release();
  await leaving;
  assert.equal((await reading).state, "needs_login");
  assert.equal(events.filter((event) => event.state === "down").length, 0);
});

test("a start abandoned by a switch-off never holds up switching back on or disconnecting", async () => {
  const { gateway, container } = await joined();
  await gateway.select(caller, { exitId: "n1", whenDown: "stop" });
  container.crash();
  const held = container.hold("/status");
  const tunnel = gateway.openTunnel({ owner }).catch(() => {});
  await held.reached;
  await gateway.select(caller, { exitId: null, whenDown: "stop" });
  const on = gateway.select(caller, { exitId: "n1", whenDown: "stop" });
  await settle();
  held.release();
  assert.equal((await on).state, "active");
  await tunnel;
  await gateway.select(caller, { exitId: null, whenDown: "stop" });
  const again = container.hold("/status");
  const listing = gateway.exits(caller).catch(() => {});
  await again.reached;
  await gateway.select(caller, { exitId: null, whenDown: "stop" });
  const leaving = gateway.disconnect(caller);
  await settle();
  again.release();
  await leaving;
  await listing;
  assert.equal(container.logouts, 1);
});

test("a select the gateway applied stands even if the identity read after it fails", async () => {
  const { gateway, container, storage, events } = await joined();
  container.crash();
  container.failStates = 1;
  const reading = await gateway.select(caller, { exitId: "n1", whenDown: "stop" });
  assert.equal(reading.state, "active");
  assert.deepEqual(await storage.get("route-v1:selection"), { exitId: "n1", whenDown: "stop" });
  assert.notEqual(storage.alarm, null);
  assert.equal(events.length, 0);
});

test("a gateway reply that breaks the wire is refused by reason code, never its text", async () => {
  const { gateway, container } = await joined();
  container.garbleNext = "/exits";
  await refusedWith(gateway.exits(caller), "route_gateway_unavailable");
});

test("a disconnect whose start a switch-off abandoned still logs the device out", async () => {
  const { gateway, container, storage } = await joined();
  await gateway.select(caller, { exitId: "n1", whenDown: "stop" });
  container.crash();
  const held = container.hold("/status");
  const tunnel = gateway.openTunnel({ owner }).catch(() => {});
  await held.reached;
  const leaving = gateway.disconnect(caller);
  await settle();
  await gateway.select(caller, { exitId: null, whenDown: "stop" });
  held.release();
  await leaving;
  await tunnel;
  assert.equal(container.logouts, 1);
  assert.equal(await storage.get("route-v1:state"), undefined);
  assert.equal(container.running, false);
});

test("a sign-in whose node died ends without a launch, a down reading or an event", async () => {
  const { gateway, container, events, storage } = await created();
  await gateway.login(caller);
  container.crash();
  const starts = container.starts.length;
  await gateway.alarm();
  assert.equal(container.running, false);
  assert.equal(container.starts.length, starts);
  assert.equal(await storage.get("route-v1:login-until"), undefined);
  assert.equal((await gateway.reading(caller)).state, "needs_login");
  assert.equal(events.filter((event) => event.state === "down").length, 0);
});

test("an exit cannot be chosen before the identity is sealed, even while the node runs", async () => {
  const { gateway, container, storage } = await created();
  await gateway.login(caller);
  await refusedWith(
    gateway.select(caller, { exitId: "n1", whenDown: "stop" }),
    "route_needs_login",
  );
  assert.equal(await storage.get("route-v1:selection"), undefined);
  container.approve();
  await gateway.joinStatus(caller);
  assert.equal((await gateway.select(caller, { exitId: "n1", whenDown: "stop" })).state, "active");
});

test("a restart during a sign-in asks for a new sign-in instead of waiting on a dead link", async () => {
  const { gateway, container, advance } = await created();
  await gateway.login(caller);
  assert.deepEqual(await gateway.joinStatus(caller), { state: "waiting" });
  container.crash();
  const starts = container.starts.length;
  advance(2_000);
  await gateway.alarm();
  assert.deepEqual(await gateway.joinStatus(caller), {
    state: "failed",
    reason: "route_needs_login",
  });
  // The dead sign-in boots no empty node to look at.
  assert.equal(container.starts.length, starts);
  assert.equal(container.running, false);
  assert.equal("url" in (await gateway.login(caller)) ? "new link" : "ready", "new link");
});

test("stop when down: an offline exit refuses tunnels, and a recovered one opens them at once", async () => {
  const { gateway, container } = await joined();
  await gateway.select(caller, { exitId: "n1", whenDown: "stop" });
  container.exitOnline = false;
  assert.equal((await gateway.reading(caller)).state, "down");
  await refusedWith(gateway.openTunnel({ owner }), "route_gateway_unavailable");
  container.exitOnline = true;
  const socket = await gateway.openTunnel({ owner });
  await socket.close();
});

test("a burst of tunnels on a down route shares one fresh read", async () => {
  const { gateway, container } = await joined();
  await gateway.select(caller, { exitId: "n1", whenDown: "stop" });
  container.exitOnline = false;
  assert.equal((await gateway.reading(caller)).state, "down");
  container.requests = [];
  await gateway.reading(caller);
  const read = container.requests.length;
  container.requests = [];
  await refusedWith(gateway.openTunnel({ owner }), "route_gateway_unavailable");
  const one = container.requests.length;
  // A tunnel on a down route costs one read and nothing more: no start and no connect.
  assert.equal(one, read);
  container.requests = [];
  const burst = await Promise.allSettled(
    Array.from({ length: 5 }, () => gateway.openTunnel({ owner })),
  );
  assert.ok(burst.every((result) => result.status === "rejected"));
  assert.equal(container.requests.length, one);
});

test("a choice overtaken while its identity read is in flight is not confirmed", async () => {
  const { gateway, container, storage } = await joined();
  await gateway.select(caller, { exitId: "n1", whenDown: "stop" });
  const held = container.hold("/state");
  const choosing = gateway.select(caller, { exitId: "n2", whenDown: "stop" });
  await held.reached;
  await gateway.select(caller, { exitId: null, whenDown: "stop" });
  held.release();
  await refusedWith(choosing, "route_gateway_unavailable");
  assert.equal((await storage.get<{ exitId: string | null }>("route-v1:selection"))?.exitId, null);
});

/** Answers the first held request to `path` (the fake in manual mode) and lets the gateway run on. */
async function answer(
  container: ReturnType<typeof gatewayDependencies>["container"],
  path: string,
  outcome: "ok" | "fail" | "lost" = "ok",
) {
  for (let tries = 0; tries < 50 && !container.waiting.some((r) => r.path === path); tries += 1)
    await settle();
  const index = container.waiting.findIndex((request) => request.path === path);
  assert.ok(index >= 0, `nothing waits on ${path}`);
  container.waiting.splice(index, 1)[0]!.release(outcome);
  await settle();
}

const unreadableSeal = async () => ({
  sealed: await sealRouteState("c".repeat(64), routeId, "lost"),
  bootId: "boot-x",
  revision: 1,
});

test("a tunnel whose route reads down while it starts is refused before it connects", async () => {
  const { gateway, container } = await joined();
  await gateway.select(caller, { exitId: "n1", whenDown: "stop" });
  container.manual = true;
  const reading = gateway.reading(caller);
  await answer(container, "/status");
  // The read's status call is in flight; the tunnel still sees the last reading routed.
  const tunnel = gateway.openTunnel({ owner });
  tunnel.catch(() => {});
  await settle();
  container.exitOnline = false;
  await answer(container, "/status");
  assert.equal((await reading).state, "down");
  await answer(container, "/status");
  await refusedWith(tunnel, "route_gateway_unavailable");
  assert.ok(!container.waiting.some((request) => request.path === "connect"));
});

test("a tunnel whose route reads down while it connects is closed and refused", async () => {
  const { gateway, container } = await joined();
  await gateway.select(caller, { exitId: "n1", whenDown: "stop" });
  container.manual = true;
  const tunnel = gateway.openTunnel({ owner });
  tunnel.catch(() => {});
  await answer(container, "/status");
  container.exitOnline = false;
  const reading = gateway.reading(caller);
  await answer(container, "/status");
  await answer(container, "/status");
  assert.equal((await reading).state, "down");
  await answer(container, "connect");
  await refusedWith(tunnel, "route_gateway_unavailable");
  assert.equal(container.openTunnels, 0);
});

test("a start whose container crashes mid-start plans again before it relaunches", async () => {
  const { gateway, container, storage } = await joined();
  await gateway.select(caller, { exitId: "n1", whenDown: "stop" });
  await storage.put("route-v1:state", await unreadableSeal());
  let launches = 0;
  container.onLaunch = () => (launches += 1);
  const held = container.hold("/status");
  const reading = gateway.reading(caller);
  await held.reached;
  container.crash();
  held.release();
  assert.equal((await reading).state, "needs_login");
  assert.equal(launches, 0);
  assert.equal(container.running, false);
});

test("switching off during a re-sign-in puts the kept node off and closes its tunnels", async () => {
  const { gateway, container } = await joined();
  await gateway.select(caller, { exitId: "n1", whenDown: "stop" });
  await gateway.openTunnel({ owner });
  container.expireKey();
  assert.ok("url" in (await gateway.login(caller)));
  container.approve();
  assert.equal(container.appliedExit, "n1");
  assert.equal(container.openTunnels, 1);
  assert.equal((await gateway.select(caller, { exitId: null, whenDown: "stop" })).state, "off");
  await settle();
  // The sign-in keeps its node, so the person's link still works, but it routes nothing.
  assert.equal(container.running, true);
  assert.equal(container.appliedExit, null);
  assert.equal(container.openTunnels, 0);
});

test("a node booting while a re-signing route switches off applies off, never the old exit", async () => {
  const { gateway, container } = await joined();
  await gateway.select(caller, { exitId: "n1", whenDown: "stop" });
  container.expireKey();
  assert.ok("url" in (await gateway.login(caller)));
  container.crash();
  container.selects = [];
  const held = container.hold("/start");
  const reading = gateway.reading(caller);
  await held.reached;
  await gateway.select(caller, { exitId: null, whenDown: "stop" });
  held.release();
  await reading.catch(() => {});
  await settle();
  assert.ok(container.selects.length > 0);
  assert.ok(container.selects.every((selection) => selection.exit_id === null));
});

test("a re-sign-in whose node died on an off route ends without a launch", async () => {
  const { gateway, container, storage } = await joined();
  container.expireKey();
  assert.ok("url" in (await gateway.login(caller)));
  container.crash();
  let launches = 0;
  container.onLaunch = () => (launches += 1);
  assert.deepEqual(await gateway.joinStatus(caller), {
    state: "failed",
    reason: "route_needs_login",
  });
  assert.equal(launches, 0);
  assert.equal(await storage.get("route-v1:login-until"), undefined);
});

test("a choice stored before an event overtook it is refused but still polled", async () => {
  const { gateway, container, storage } = await joined();
  await gateway.alarm();
  assert.equal(storage.alarm, null);
  const held = container.hold("/state");
  const choosing = gateway.select(caller, { exitId: "n1", whenDown: "stop" });
  await held.reached;
  const signIn = gateway.login(caller);
  await settle();
  held.release();
  assert.deepEqual(await signIn, { state: "ready" });
  await refusedWith(choosing, "route_gateway_unavailable");
  assert.equal((await storage.get<{ exitId: string }>("route-v1:selection"))?.exitId, "n1");
  assert.notEqual(storage.alarm, null);
});

test("a seal no key opens forgets its exit too and reads signed out, not down", async () => {
  const { gateway, container, storage, events } = await joined();
  await gateway.select(caller, { exitId: "n1", whenDown: "stop" });
  await storage.put("route-v1:state", await unreadableSeal());
  container.crash();
  assert.equal((await gateway.reading(caller)).state, "needs_login");
  assert.equal(await storage.get("route-v1:selection"), undefined);
  assert.deepEqual(events, []);
  assert.equal(container.running, false);
  // The next sign-in joins off.
  await gateway.login(caller);
  container.approve();
  assert.equal((await gateway.joinStatus(caller)).state, "connected");
  assert.equal(container.appliedExit, null);
});

test("a start for an exit switched off since never relaunches after a crash", async () => {
  const { gateway, container } = await joined();
  await gateway.select(caller, { exitId: "n1", whenDown: "stop" });
  container.expireKey();
  assert.ok("url" in (await gateway.login(caller)));
  container.crash();
  let launches = 0;
  container.onLaunch = () => (launches += 1);
  const held = container.hold("/status");
  const reading = gateway.reading(caller);
  await held.reached;
  // The open sign-in keeps the node, so the switch-off does not stop the start in flight.
  await gateway.select(caller, { exitId: null, whenDown: "stop" });
  container.crash();
  held.release();
  await reading.catch(() => {});
  await settle();
  assert.equal(launches, 1);
  assert.equal(container.running, false);
});

test("a node that must not boot is destroyed in order, never taking down a later one", async () => {
  const { gateway, container } = await joined();
  container.expireKey();
  assert.ok("url" in (await gateway.login(caller)));
  // A container left up with no node started in it, as an abandoned start leaves one.
  container.crash();
  container.start({ enableInternet: true });
  container.manual = true;
  // The poll finds no sign-in node to read; its plan refuses and the container is destroyed.
  const polled = gateway.joinStatus(caller).catch(() => undefined);
  await answer(container, "/status");
  assert.ok(container.waiting.some((request) => request.path === "destroy"));
  const logouts = container.logouts;
  const leaving = gateway.disconnect(caller);
  // Give the disconnect time to queue its own destroy, if it does not wait for the first.
  for (let tries = 0; tries < 10 && container.waiting.length < 2; tries += 1) await settle();
  // The newest destroy is answered first, and the oldest lands just before the logout, as a slow
  // destroy would.
  for (let round = 0; round < 50; round += 1) {
    const { waiting } = container;
    const logout = waiting.find((request) => request.path === "/logout");
    const oldest = waiting.find((request) => request.path === "destroy");
    const next =
      logout && oldest
        ? oldest
        : (waiting.find((request) => request.path !== "destroy") ?? waiting.at(-1));
    if (!next) break;
    waiting.splice(waiting.indexOf(next), 1);
    next.release("ok");
    await settle();
  }
  await polled;
  await leaving;
  assert.equal(container.logouts, logouts + 1, "the logout node was taken down");
});

test("a switch-off's realignment never touches a disconnect's logout node", async () => {
  const { gateway, container } = await joined();
  await gateway.select(caller, { exitId: "n1", whenDown: "stop" });
  container.expireKey();
  assert.ok("url" in (await gateway.login(caller)));
  container.crash();
  const held = container.hold("/status");
  const reading = gateway.reading(caller).catch(() => undefined);
  await held.reached;
  // The open sign-in keeps the node, so the switch-off realigns it once the start is done.
  await gateway.select(caller, { exitId: null, whenDown: "stop" });
  const logouts = container.logouts;
  const leaving = gateway.disconnect(caller);
  await settle();
  held.release();
  await reading;
  await leaving;
  assert.equal(container.logouts, logouts + 1, "the logout node was taken down");
  assert.equal(container.running, false);
});
