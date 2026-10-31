import assert from "node:assert/strict";
import { test } from "node:test";
import { PoolRuntimeUnhealthy, type PoolStatus } from "./lifecycle.ts";
import { NativeStreams } from "./native-streams.ts";
import { RuntimeProtection } from "./runtime-protection.ts";
import { policyHealthHeader, readRuntimeHealth } from "./runtime-health.ts";

class Clock {
  time = 0;
  timers = new Set<{ at: number; resolve(): void }>();
  observers = new Map<number, (() => void)[]>();
  pause = (milliseconds: number) => {
    let resolve!: () => void;
    const promise = new Promise<void>((done) => { resolve = done; });
    const timer = { at: this.time + milliseconds, resolve };
    this.timers.add(timer);
    for (const done of this.observers.get(timer.at) ?? []) done();
    this.observers.delete(timer.at);
    return { promise, cancel: () => { this.timers.delete(timer); } };
  };
  scheduled(at: number) {
    if ([...this.timers].some((timer) => timer.at === at)) return Promise.resolve();
    return new Promise<void>((done) => { this.observers.set(at, [...this.observers.get(at) ?? [], done]); });
  }
  advance(to: number) {
    this.time = to;
    for (const timer of this.timers) if (timer.at <= to) { this.timers.delete(timer); timer.resolve(); }
  }
}
function fixture(check: (call: number) => Promise<PoolStatus>) {
  const clock = new Clock(), streams = new NativeStreams(), background: Promise<void>[] = [], failures: number[] = [];
  let calls = 0, closes = 0;
  const socket = streams.acquire("socket", "pool-a", new AbortController().signal);
  socket.onClose(() => { closes += 1; });
  const protection = new RuntimeProtection(streams, {
    check: () => check(++calls), defer: (work) => { background.push(work); },
    unavailable: (count) => { failures.push(count); }, now: () => clock.time, pause: clock.pause,
  });
  const status = { boot_id: "boot", started_at: "2026-10-31T12:00:00Z", policyLeaseUntil: 1_500 };
  protection.admit(status);
  return { clock, streams, socket, background, failures, protection, status, calls: () => calls, closes: () => closes };
}

test("an idle upgraded socket closes at the acknowledged lease deadline even when every later probe hangs", async () => {
  const f = fixture(() => new Promise(() => {}));
  f.clock.advance(500);
  await f.clock.scheduled(750);
  f.clock.advance(750);
  await f.clock.scheduled(1_250);
  assert.equal(f.socket.signal.aborted, false, "one missed refresh inside the lease must not flap");
  f.clock.advance(1_250);
  await f.clock.scheduled(1_500);
  f.clock.advance(1_500);
  await f.background[0];
  assert.equal(f.socket.signal.aborted, true);
  assert.equal(f.closes(), 1);
  assert.deepEqual(f.failures, [1]);
  assert.equal(f.calls(), 2);
});

test("a healthy renewal survives one missed probe and active stream completion stops the watcher", async () => {
  const f = fixture(async (call) => call === 2 ? new Promise(() => {}) : {
    boot_id: "boot", started_at: "2026-10-31T12:00:00Z", policyLeaseUntil: call === 1 ? 2_000 : 3_250,
  });
  f.clock.advance(500);
  await f.clock.scheduled(1_000);
  f.clock.advance(1_000);
  await f.clock.scheduled(1_250);
  f.clock.advance(1_250);
  await f.clock.scheduled(1_750);
  assert.equal(f.socket.signal.aborted, false);
  f.clock.advance(1_750);
  await f.clock.scheduled(2_250);
  assert.equal(f.socket.signal.aborted, false);
  assert.deepEqual(f.failures, []);
  f.socket.release();
  f.clock.advance(2_250);
  await f.background[0];
  assert.equal(f.streams.active, 0);
  assert.equal(f.calls(), 3);
});

test("an explicit unhealthy readiness response closes current HTTP and WebSocket leases before expiry", async () => {
  const f = fixture(async () => { throw new PoolRuntimeUnhealthy(); });
  const http = f.streams.acquire("http", "pool-b", new AbortController().signal);
  f.clock.advance(500);
  await f.background[0];
  assert.equal(f.socket.signal.aborted, true);
  assert.equal(http.signal.aborted, true);
  assert.deepEqual(f.failures, [2]);
});

test("a missing, expired or malformed lease cannot admit a native stream", async () => {
  const f = fixture(() => new Promise(() => {}));
  for (const deadline of [undefined, NaN, 0])
    assert.throws(() => f.protection.admit({ ...f.status, policyLeaseUntil: deadline }), PoolRuntimeUnhealthy);
  f.socket.release();
  f.clock.advance(500);
  await f.background[0];
});

test("transport delay consumes the container lease rather than extending it", async () => {
  let now = 10;
  const readiness = { fetch: async () => {
    now = 510;
    return Response.json({ boot_id: "boot", started_at: "2026-10-31T12:00:00Z" }, {
      headers: { [policyHealthHeader]: "1000" },
    });
  } };
  const status = await readRuntimeHealth(readiness, "fixture", new AbortController().signal, () => now);
  assert.equal(status.policyLeaseUntil, 1_010);
  for (const value of ["0", "1501", "invalid"]) {
    const invalid = await readRuntimeHealth({ fetch: async () => Response.json({ boot_id: "boot", started_at: "now" }, {
      headers: { [policyHealthHeader]: value },
    }) }, "fixture", new AbortController().signal);
    assert.equal(invalid.policyLeaseUntil, undefined);
  }
});
