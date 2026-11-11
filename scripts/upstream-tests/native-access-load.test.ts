import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { fixture } from "./native-device-fixture.ts";

test("native access budgets isolate devices at one proxy address and recover next minute", async (t) => {
  const db = new DatabaseSync(":memory:");
  let now = Date.now();
  t.mock.method(Date, "now", () => now);
  let computers = 0;
  using f = await fixture(
    async (request) => {
      const { envelope } = await request.json();
      const { action } = JSON.parse(Buffer.from(envelope.split(".")[1], "base64url").toString());
      return Response.json(
        action === "register"
          ? { computer: { id: `computer-${++computers}` }, pool: "pool-fixture", models: true }
          : { active: true },
      );
    },
    undefined,
    db,
  );
  try {
    const authorize = async (code: { user_code: string; device_code: string }) => {
      const approved = await f.request(
        "/device/decide",
        { user_code: code.user_code, accept: true },
        {
          "x-basalt-native-intent": "synthetic-intent",
          "x-basalt-native-name": "Test device",
          "x-basalt-native-pool": "pool-fixture",
          "x-basalt-native-models": "true",
          "x-basalt-native-tools": "false",
        },
      );
      assert.equal(approved.status, 200);
      const response = await f.raw("/oauth2/token", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "urn:ietf:params:oauth:grant-type:device_code",
          device_code: code.device_code,
          client_id: f.client_id,
          code_verifier: f.verifier,
          resource: "http://localhost:3000/native",
        }),
      });
      assert.equal(response.status, 200);
      return (await response.json()).access_token as string;
    };
    const first = await authorize(f);
    const start = await f.raw("/oauth2/device-authorization", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: f.client_id,
        scope: "native offline_access",
        resource: "http://localhost:3000/native",
        code_challenge: createHash("sha256").update(f.verifier).digest("base64url"),
        code_challenge_method: "S256",
      }),
    });
    assert.equal(start.status, 200);
    const second = await authorize(await start.json());
    const access = (token: string) =>
      f.raw("/native/access", { headers: { authorization: `Bearer ${token}` } });
    const held = f.holdMissingBudgetIncrement();
    const firstWindow = access(first);
    await held.arrived;
    assert.equal((await access(first)).status, 200, "A sibling creates the missing device window.");
    held.release();
    assert.equal(
      (await firstWindow).status,
      200,
      "The delayed initial request must consume remaining budget, not invent 429.",
    );
    const initial = await Promise.all(Array.from({ length: 130 }, () => access(first)));
    assert.ok(
      initial.every((response) => response.status === 200),
      "agent bursts must exceed the old shared 100-check limit",
    );
    for (let count = 132; count < 1190; count += 20) {
      const responses = await Promise.all(
        Array.from({ length: Math.min(20, 1190 - count) }, () => access(first)),
      );
      assert.ok(responses.every((response) => response.status === 200));
    }
    const edge = await Promise.all(Array.from({ length: 20 }, () => access(first)));
    assert.equal(
      edge.filter((response) => response.status === 200).length,
      10,
      "SQL increments must enforce exactly 1200 checks under concurrency",
    );
    const refused = edge.filter((response) => response.status === 429);
    assert.equal(refused.length, 10);
    assert.ok(refused.every((response) => Number(response.headers.get("retry-after")) > 0));
    assert.equal(
      (await access(second)).status,
      200,
      "another device on the same account/address must retain its budget",
    );
    assert.equal((await access(first)).status, 429);
    now += 60_000;
    assert.equal(
      (await access(first)).status,
      200,
      "a fixed window must recover without a quiet traffic period",
    );
    assert.equal(
      (await f.raw("/native/access", { headers: { authorization: "Bearer invalid" } })).status,
      401,
    );
  } finally {
    db.close();
  }
});
