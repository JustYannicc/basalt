// Regression: api-startup-750ms
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  firstEventWorkers,
  violations,
  workerStartupBudgetMs,
  type Measurement,
} from "../worker-startup.ts";

/**
 * Production refused releases because Cloudflare measured Api's startup over the barrier's 750 ms
 * ceiling on 2 of 3 samples. Cloudflare's figure sits at 2x or more of local CPU, so check:startup
 * holds Api to a local budget well under that, and has to catch the growth before a release does.
 * Api now imports its application on its first event, so that application is where the cost lives.
 */
const sampled = (name: string, startupMs: number[]): Measurement => ({
  name,
  bytes: 1,
  gzipBytes: 1,
  startupMs,
  inconclusive: 0,
});

test("Api's application fails check:startup when most of its samples exceed Api's budget", () => {
  assert.ok(firstEventWorkers.includes("Api"), "Api's lazy application must be measured");
  const budget = workerStartupBudgetMs.Api;
  for (const name of ["Api", "Api (first event)"]) {
    // Two of three samples over the budget: the Worker would reach the release and be refused there.
    const majority = sampled(name, [budget + 30, 50, budget + 40]);
    assert.match(
      violations(majority).join("\n"),
      new RegExp(`${name.replace(/[()]/g, "\\$&")} starts in .* the budget is ${budget} ms`),
      `${name} passed check:startup with two of three samples over ${budget} ms`,
    );
    // One noisy sample alone is not growth.
    assert.deepEqual(violations(sampled(name, [budget + 300, 50, 60])), []);
  }
});
