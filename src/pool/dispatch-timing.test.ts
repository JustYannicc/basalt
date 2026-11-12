import assert from "node:assert/strict";
import { test } from "node:test";
import { logDispatchTiming } from "./dispatch-timing.ts";

test("dispatch timing logs only closed bounded metadata", () => {
  const logged: unknown[] = [];
  const original = console.info;
  console.info = (...args: unknown[]) => {
    logged.push(args);
  };
  try {
    const metrics = ["authenticate", "selection", "admission", "reply_write", "ping", "rpop"].map(
      (stage, duration_ms) => ({ stage, duration_ms, outcome: "ok" }),
    );
    logDispatchTiming(JSON.stringify(metrics));
    assert.deepEqual(
      logged,
      metrics.map((metric) => ["POOL_DISPATCH_TIMING", metric]),
    );
    for (const invalid of [
      "private-sentinel",
      JSON.stringify([{ ...metrics[0], private: "private-sentinel" }]),
      JSON.stringify([{ ...metrics[0], duration_ms: -1 }]),
      JSON.stringify([{ ...metrics[0], duration_ms: 86_400_001 }]),
      JSON.stringify([{ ...metrics[0], duration_ms: 1.5 }]),
      JSON.stringify([{ ...metrics[0], outcome: "private-sentinel" }]),
      JSON.stringify([metrics[0], metrics[0]]),
      JSON.stringify([...metrics, { stage: "private-sentinel", duration_ms: 1, outcome: "ok" }]),
      JSON.stringify([{ stage: "authenticate", outcome: "ok" }]),
      " ".repeat(2049),
    ]) {
      logDispatchTiming(invalid);
      assert.equal(logged.length, 6);
    }
  } finally {
    console.info = original;
  }
});
