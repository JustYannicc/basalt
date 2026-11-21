import assert from "node:assert/strict";
import { test } from "node:test";
import type { ConnectionView } from "../contracts/connection.ts";
import { namesNoPool } from "../contracts/pool-display.ts";
import { modelsRow } from "../desktop/status.ts";

const account = { name: "Alex Example", email: "alex@example.com", emailVerified: true };
const device = (
  state: ConnectionView["state"],
  capabilities: ConnectionView["capabilities"],
  pool: { id: string; name: string },
): ConnectionView => ({
  state,
  mode: "device",
  capabilities,
  display: { account, pool, pools: [] },
  origin: "https://signalbox.example",
});

test("a tools-only device's connection page names no pool and offers none", () => {
  // Its access answer names no pool. Disconnecting keeps that answer but drops the capabilities.
  const none = { id: "pool-1", name: "" };
  for (const view of [device("connected", ["tools"], none), device("disconnected", [], none)])
    assert.deepEqual(
      modelsRow(view, view.state === "connected"),
      { text: "Not included in this connection", choosePool: false },
      view.state,
    );
});

test("a device with models names its pool and offers choosing another", () => {
  const pool = { id: "pool-1", name: "Alex's pool" };
  for (const view of [
    device("connected", ["models", "tools"], pool),
    device("disconnected", [], pool),
  ])
    assert.deepEqual(
      modelsRow(view, view.state === "connected"),
      { text: "Alex's pool", choosePool: true },
      view.state,
    );
  // Before its first access answer, nothing says whether the device has models.
  assert.deepEqual(modelsRow({ state: "disconnected", mode: "device", capabilities: [] }, false), {
    text: "Reconnect to load pool details",
    choosePool: true,
  });
  assert.deepEqual(
    modelsRow({ state: "connected", mode: "direct", capabilities: ["models"] }, true),
    {
      text: "Your direct key",
      choosePool: false,
    },
  );
});

test("only an access answer that names no pool marks a tools-only device", () => {
  // The phone hides its pool line and pool chooser on the same rule.
  assert.equal(namesNoPool(device("disconnected", [], { id: "pool-1", name: "" })), true);
  assert.equal(namesNoPool(device("connected", ["models"], { id: "pool-1", name: "Pool" })), false);
  assert.equal(namesNoPool({}), false);
  assert.equal(namesNoPool(undefined), false);
});
