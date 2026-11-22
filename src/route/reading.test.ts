import assert from "node:assert/strict";
import { test } from "node:test";
import { crossesDown, readingFromStatus, settle, type GatewayStatus } from "./reading.ts";
import { openRouteState, sealRouteState } from "./state.ts";

const base: GatewayStatus = {
  boot_id: "boot-1",
  state: "ready",
  reason: null,
  when_down: "stop",
  exit: { id: "n1", name: "home-exit", online: true, path: "direct", relay_region: null },
  node: { logged_in: true, key_expiry: null, tailnet: "example-tailnet" },
  state_revision: 1,
};

test("gateway states map onto the reading the owner sees", () => {
  const cases: Array<[Partial<GatewayStatus>, string, string | null]> = [
    [{}, "active", null],
    [{ state: "needs_login", reason: "route_needs_login" }, "needs_login", "route_needs_login"],
    [{ state: "needs_login", reason: "route_key_expired" }, "needs_login", "route_key_expired"],
    [{ state: "down", reason: "route_exit_unreachable" }, "down", "route_exit_unreachable"],
    [{ state: "down", reason: "route_off" }, "off", "route_off"],
    [
      { state: "direct_fallback", reason: "route_exit_offline" },
      "direct_fallback",
      "route_exit_offline",
    ],
    [{ state: "down", reason: null }, "down", "route_status_unavailable"],
  ];
  for (const [change, state, reason] of cases) {
    const reading = readingFromStatus({ ...base, ...change }, 5);
    assert.equal(reading.state, state);
    assert.equal(reading.reason, reason);
  }
  assert.deepEqual(readingFromStatus(base, 5), {
    state: "active",
    reason: null,
    exitName: "home-exit",
    tailnet: "example-tailnet",
    deviceName: null,
    deviceId: null,
    keyExpiry: null,
    path: "direct",
    relayRegion: null,
    checkedAt: 5,
    whenDown: "stop",
  });
  const bare = readingFromStatus(
    { ...base, exit: null, node: { logged_in: false, key_expiry: null } },
    5,
  );
  assert.equal(bare.path, "unknown");
  assert.equal(bare.tailnet, null);
});

test("only crossing the down line counts as a change", () => {
  const at = (state: "active" | "down" | "off") => ({ ...readingFromStatus(base, 1), state });
  assert.equal(crossesDown(undefined, at("active")), false);
  assert.equal(crossesDown(undefined, at("down")), true);
  assert.equal(crossesDown(at("active"), at("down")), true);
  assert.equal(crossesDown(at("down"), at("down")), false);
  assert.equal(crossesDown(at("down"), at("off")), true);
  assert.equal(crossesDown(at("active"), at("off")), false);
});

test("sealed state opens only for its own route and key, and through the previous key", async () => {
  const sealed = await sealRouteState("k".repeat(64), "rt_one", "state-bytes");
  assert.deepEqual(await openRouteState("k".repeat(64), "rt_one", sealed), {
    state: "state-bytes",
    reseal: false,
  });
  await assert.rejects(openRouteState("k".repeat(64), "rt_two", sealed));
  await assert.rejects(openRouteState("j".repeat(64), "rt_one", sealed));
  assert.deepEqual(await openRouteState("j".repeat(64), "rt_one", sealed, "k".repeat(64)), {
    state: "state-bytes",
    reseal: true,
  });
});

test("a reading keeps its since while its state holds", () => {
  const observed = readingFromStatus(base, 5);
  const first = settle(undefined, observed);
  assert.equal(first.since, 5);
  assert.equal(settle(first, { ...observed, checkedAt: 9 }).since, 5);
  assert.equal(settle(first, { ...observed, state: "down", checkedAt: 9 }).since, 9);
  const named = readingFromStatus(
    {
      ...base,
      node: { ...base.node, name: "signalbox-route", key_expiry: "2027-01-01T00:00:00Z" },
    },
    5,
  );
  assert.equal(named.deviceName, "signalbox-route");
  assert.equal(named.keyExpiry, Date.parse("2027-01-01T00:00:00Z"));
  assert.equal(
    readingFromStatus({ ...base, node: { ...base.node, key_expiry: "soon" } }, 5).keyExpiry,
    null,
  );
});
