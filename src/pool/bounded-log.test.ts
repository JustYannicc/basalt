import assert from "node:assert/strict";
import { test } from "node:test";
import { boundedLog, boundedLogLimit, boundedLogWindowMs } from "./bounded-log.ts";

test("a storm writes at most the bound per window, and the next line counts what it left out", () => {
  const written: [string, Record<string, unknown>][] = [];
  const write = (name: string, fields: Record<string, unknown>) =>
    void written.push([name, fields]);
  const name = `FIXTURE_LINE_${crypto.randomUUID()}`;
  for (let i = 0; i < boundedLogLimit + 50; i++) boundedLog(name, { i }, write, 1_000);
  assert.equal(written.length, boundedLogLimit);
  assert.deepEqual(written.at(-1), [name, { i: boundedLogLimit - 1 }]);
  boundedLog(name, { i: "next" }, write, 1_000 + boundedLogWindowMs);
  assert.deepEqual(written.at(-1), [name, { i: "next", suppressed: 50 }]);
  boundedLog(name, { i: "after" }, write, 1_000 + boundedLogWindowMs);
  assert.deepEqual(written.at(-1), [name, { i: "after" }]);
});
