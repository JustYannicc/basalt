import assert from "node:assert/strict";
import { test } from "node:test";
import { RouteReadings, gatewayReader } from "./route-reading.ts";

const route = "rt_" + "r".repeat(26);
const owner = "org/example-organization/user/example-user";
const active = {
  state: "active",
  reason: null,
  exitName: "home-exit",
  path: "direct",
  relayRegion: null,
  since: 5,
  extra: 1,
};

test("a pool view reads a route's gateway at most once per alarm interval, as its owner", async () => {
  let now = 1_000;
  const calls: [string, string][] = [];
  const readings = new RouteReadings(
    async (routeId, caller) => {
      calls.push([routeId, caller]);
      return active;
    },
    () => now,
  );
  const first = await readings.read(route, owner);
  assert.deepEqual(first, {
    state: "active",
    reason: null,
    exitName: "home-exit",
    path: "direct",
    relayRegion: null,
    since: 5,
  });
  now += 4 * 60_000;
  await readings.read(route, owner);
  assert.deepEqual(calls, [[route, owner]]);
  now += 2 * 60_000;
  await readings.read(route, owner);
  assert.equal(calls.length, 2);
});

test("an unreachable or unbound gateway reads as down with a reason code, retried soon", async () => {
  let now = 1_000;
  let fail = true;
  const readings = new RouteReadings(
    async () => {
      if (fail) throw new Error("synthetic");
      return active;
    },
    () => now,
  );
  const down = await readings.read(route, owner);
  assert.equal(down.state, "down");
  assert.equal(down.reason, "route_gateway_unavailable");
  fail = false;
  now += 31_000;
  assert.equal((await readings.read(route, owner)).state, "active");
  assert.equal(
    (await new RouteReadings(undefined).read(route, owner)).reason,
    "route_gateway_unavailable",
  );
  const malformed = new RouteReadings(async () => ({ state: "sideways" }));
  assert.equal((await malformed.read(route, owner)).reason, "route_gateway_unavailable");
});

test("the gateway is asked with exactly { routeId, owner }, and its reason codes come through", async () => {
  // Decodes the caller as strictly as the RouteGateway DO does.
  const strict = (id: string) => ({
    reading: async (caller: Record<string, unknown>) => {
      const keys = Object.keys(caller).sort();
      if (
        keys.join() !== "owner,routeId" ||
        caller.routeId !== id ||
        typeof caller.owner !== "string" ||
        !/^org\/[^/]+\/user\/[^/]+$/.test(caller.owner)
      )
        throw new Error("route_not_permitted");
      if (id.endsWith("x")) throw new Error("route_exit_offline");
      return active;
    },
  });
  const namespace = {
    idFromName: (name: string) => name,
    get: (id: never) => strict(id as string),
  };
  const readings = new RouteReadings(gatewayReader(namespace));
  assert.equal((await readings.read(route, owner)).state, "active");
  const offline = await readings.read("rt_" + "x".repeat(26), owner);
  assert.deepEqual([offline.state, offline.reason], ["down", "route_exit_offline"]);
  const refused = await new RouteReadings(gatewayReader(namespace)).read(route, "someone");
  assert.equal(refused.reason, "route_not_permitted");
});
