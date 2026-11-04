import assert from "node:assert/strict";
import test from "node:test";
import { adoptionStepGate } from "./production-ops/adoption-step-gate.ts";

test("concurrent proof identities cannot release or occupy each other's SQL gate", async (t) => {
  const gate = await adoptionStepGate();
  t.after(gate.close);
  const request = async (action: string, id: string) => {
    const url = new URL(`/${action}`, gate.origin);
    url.searchParams.set("step", "organization");
    url.searchParams.set("id", id);
    assert.equal((await fetch(url, { method: "POST" })).status, 204);
  };
  await Promise.all([request("arm", "case-a"), request("arm", "case-b")]);
  let releasedA = false;
  let releasedB = false;
  const first = request("arrive", "case-a").then(() => {
    releasedA = true;
  });
  const second = request("arrive", "case-b").then(() => {
    releasedB = true;
  });
  await Promise.all([request("entered", "case-a"), request("entered", "case-b")]);
  assert.equal(releasedA, false);
  assert.equal(releasedB, false);
  await request("release", "case-b");
  await second;
  assert.equal(releasedA, false);
  await request("arrive", "unrelated-case");
  assert.equal(releasedA, false);
  await request("release", "case-a");
  await first;
});
