import assert from "node:assert/strict";
import { test } from "node:test";
import { timePoolRead } from "./read-timing.ts";

test("Home timing excludes response data and the thrown failure", async () => {
  const logs: unknown[] = [];
  let now = 10;
  const report = (value: unknown) => { logs.push(value); };
  const clock = () => now;
  const response = { secret: "private-response", rows: [1, 2] };
  assert.equal(await timePoolRead("credentials", async () => { now = 14; return response; }, (value) => value.rows.length, report, clock), response);
  const failure = new Error("private-failure");
  await assert.rejects(timePoolRead("membership", async () => { now = 20; throw failure; }, undefined, report, clock), (value) => value === failure);
  assert.deepEqual(logs, [
    { operation: "credentials", durationMs: 4, count: 2, failures: 0 },
    { operation: "membership", durationMs: 6, count: 0, failures: 1 },
  ]);
});
