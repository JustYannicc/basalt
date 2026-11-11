import assert from "node:assert/strict";
import { test } from "node:test";
import { fixture } from "./native-device-fixture.ts";
import { fixture as poolFixture, pool } from "../../src/pool/test/computers.ts";

test("native approval also leaves margin below the pool assertion ceiling", async (t) => {
  const hostNow = Date.now();
  t.mock.method(Date, "now", () => hostNow);
  const p = poolFixture();
  p.advance(hostNow - 50 - p.now());
  using f = await fixture((request) => p.nativeControl(request));
  const user = String(f.db.user![0]!.id);
  const intent = await p.intent(user, { ...pool, owner: user });
  const response = await f.request(
    "/device/decide",
    { user_code: f.user_code, accept: true },
    {
      "x-basalt-native-intent": intent,
      "x-basalt-native-name": "Clock fixture",
      "x-basalt-native-pool": pool.pool,
      "x-basalt-native-models": "true",
      "x-basalt-native-tools": "false",
    },
  );
  assert.equal(response.status, 200, await response.clone().text());
  assert.deepEqual(await response.json(), { status: "approved" });
  assert.equal(
    Object.values(await p.registry()).filter((computer) => computer.state === "active").length,
    1,
  );
});
