import assert from "node:assert/strict";
import { test } from "node:test";
import { introSeconds, loopSeconds } from "../src/site/volcano.ts";
import { frame } from "./site-volcano.ts";

test("the loop closes on itself, so its wrap doesn't jump", () => {
  assert.deepEqual(frame(introSeconds + loopSeconds), frame(introSeconds));
  assert.deepEqual(frame(introSeconds + loopSeconds + 1.3), frame(introSeconds + 1.3));
});
