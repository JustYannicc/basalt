import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:net";
import { test } from "node:test";
import { fixtureGate, waitForFixtureRelease } from "./upstream-fixture-gate.ts";

test("release requested before the orphan connects is delivered when it arrives", async (t) => {
  const gate = await fixtureGate(t);
  const released = gate.release();
  await waitForFixtureRelease(gate.port);
  await released;
});

test("an orphan rejects a closed gate without a release", async (t) => {
  const server = createServer((socket) => socket.end());
  t.after(() => server.close());
  const listening = once(server, "listening");
  server.listen(0, "127.0.0.1");
  await listening;
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  await assert.rejects(waitForFixtureRelease(String(address.port)), /closed before release/);
});
