import assert from "node:assert/strict";
import { test } from "node:test";
import { poolArrival, poolReceiveHeader, stampPoolReceive } from "./pool-arrival.ts";

test("only the Worker's own plausible receive times reach the Durable Object's handler", () => {
  const now = Date.now();
  for (const forged of ["1,2", "abc", `${now + 5_000},${now + 5_001}`, `${now},${now - 1}`, ""]) {
    const arrival = poolArrival(
      new Request("https://pool.invalid/v1/models", { headers: { [poolReceiveHeader]: forged } }),
      now,
    );
    assert.equal(arrival.receive, undefined, forged);
    assert.equal(arrival.request.headers.has(poolReceiveHeader), false);
  }
  const caller = new Request("https://pool.invalid/v1/models", {
    method: "POST",
    body: "kept body",
    headers: { [poolReceiveHeader]: "1000000000000,1000000000001", "x-api-key": "kept" },
  });
  const arrival = poolArrival(stampPoolReceive(caller, now - 20, now - 5), now, 77);
  assert.deepEqual(arrival.receive, { receivedAt: now - 20, calledAt: now - 5 });
  assert.equal(arrival.at, now);
  assert.equal(arrival.started, 77);
  assert.equal(arrival.request.headers.get("x-api-key"), "kept");
  assert.equal(arrival.request.headers.has(poolReceiveHeader), false);
});

test("a request without the header is passed on as the same object", () => {
  const request = new Request("https://pool.invalid/v1/models");
  assert.equal(poolArrival(request).request, request);
});
