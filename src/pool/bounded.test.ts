import assert from "node:assert/strict";
import { test } from "node:test";
import { mapBounded } from "./bounded.ts";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

test("mapBounded stops starting work after the first rejection", async () => {
  const fail = deferred<void>(),
    release = deferred<void>();
  const started: number[] = [];
  const reading = mapBounded([0, 1, 2, 3, 4, 5, 6], async (value) => {
    started.push(value);
    if (value === 0) {
      await fail.promise;
      throw new Error("failed");
    }
    await release.promise;
    return value;
  });
  await new Promise((resolve) => setTimeout(resolve, 0));
  fail.resolve();
  await new Promise((resolve) => setImmediate(resolve));
  release.resolve();
  await assert.rejects(reading, /failed/);
  assert.deepEqual(started.sort(), [0, 1, 2, 3]);
});
