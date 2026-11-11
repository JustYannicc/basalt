import assert from "node:assert/strict";
import { test } from "node:test";
import { StartQueue } from "../cli/start-queue.ts";

test("queued starts expire before dispatch and do not consume later capacity", async (context) => {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  const queue = new StartQueue();
  const signal = new AbortController().signal;
  const active = await Promise.all(Array.from({ length: 32 }, () => queue.acquire(signal)));
  const expired = assert.rejects(queue.acquire(signal), /timed out before dispatch/);
  context.mock.timers.tick(30_000);
  await expired;
  active[0]!();
  const fresh = await queue.acquire(signal);
  fresh();
  for (const release of active) release();
});

test("queued starts retain arrival order while cancellation removes only its caller", async () => {
  const queue = new StartQueue();
  const signal = new AbortController().signal;
  const active = await Promise.all(Array.from({ length: 32 }, () => queue.acquire(signal)));
  const order: number[] = [];
  const first = queue.acquire(signal).then((release) => {
    order.push(1);
    return release;
  });
  const cancelled = new AbortController();
  const removed = assert.rejects(queue.acquire(cancelled.signal), { name: "AbortError" });
  const last = queue.acquire(signal).then((release) => {
    order.push(3);
    return release;
  });
  cancelled.abort();
  await removed;
  active[0]!();
  const releaseFirst = await first;
  assert.deepEqual(order, [1]);
  releaseFirst();
  const releaseLast = await last;
  assert.deepEqual(order, [1, 3]);
  releaseLast();
  for (const release of active) release();
});
