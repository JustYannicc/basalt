import assert from "node:assert/strict";
import { test } from "node:test";
import { PoolRuntimeUnhealthy, type PoolStatus } from "./lifecycle.ts";
import { NativeStreams } from "./native-streams.ts";
import { RuntimeProtection, type ProtectionDiagnostic } from "./runtime-protection.ts";
import { policyHealthHeader, readRuntimeHealth } from "./runtime-health.ts";

class Clock {
  time = 0;
  timers = new Set<{ at: number; resolve(): void }>();
  observers = new Map<number, (() => void)[]>();
  pause = (milliseconds: number) => {
    let resolve!: () => void;
    const promise = new Promise<void>((done) => {
      resolve = done;
    });
    const timer = { at: this.time + milliseconds, resolve };
    this.timers.add(timer);
    for (const done of this.observers.get(timer.at) ?? []) done();
    this.observers.delete(timer.at);
    return {
      promise,
      cancel: () => {
        this.timers.delete(timer);
      },
    };
  };
  scheduled(at: number) {
    if ([...this.timers].some((timer) => timer.at === at)) return Promise.resolve();
    return new Promise<void>((done) => {
      this.observers.set(at, [...(this.observers.get(at) ?? []), done]);
    });
  }
  advance(to: number) {
    this.time = to;
    for (const timer of this.timers)
      if (timer.at <= to) {
        this.timers.delete(timer);
        timer.resolve();
      }
  }
}
function fixture(check: (call: number) => Promise<PoolStatus>) {
  const clock = new Clock(),
    streams = new NativeStreams(),
    background: Promise<void>[] = [],
    failures: number[] = [];
  const diagnostics: ProtectionDiagnostic[] = [];
  let calls = 0,
    closes = 0;
  const socket = streams.acquire("socket", "pool-a", new AbortController().signal);
  socket.onClose(() => {
    closes += 1;
  });
  const protection = new RuntimeProtection(streams, {
    check: () => check(++calls),
    defer: (work) => {
      background.push(work);
    },
    unavailable: (count, diagnostic) => {
      failures.push(count);
      diagnostics.push(diagnostic);
    },
    now: () => clock.time,
    pause: clock.pause,
  });
  const status = { boot_id: "boot", started_at: "2026-10-31T12:00:00Z", policyLeaseUntil: 1_500 };
  protection.admit(status);
  return {
    clock,
    streams,
    socket,
    background,
    failures,
    diagnostics,
    protection,
    status,
    calls: () => calls,
    closes: () => closes,
  };
}

test("fresh same-boot readiness recovers admission while active streams stay protected", async () => {
  const f = fixture(async () => {
    throw new PoolRuntimeUnhealthy();
  });
  f.clock.advance(500);
  await f.clock.scheduled(1_000);
  assert.deepEqual(f.failures, [1]);
  try {
    assert.doesNotThrow(() => f.protection.admit({ ...f.status, policyLeaseUntil: 2_000 }));
    assert.equal(f.socket.signal.aborted, false);
  } finally {
    f.socket.release();
    f.clock.advance(1_000);
    await f.background[0];
  }
});

test("admission refuses a changed boot and closes the old streams", async () => {
  const f = fixture(async () => {
    throw new PoolRuntimeUnhealthy();
  });
  f.clock.advance(500);
  await f.clock.scheduled(1_000);
  try {
    assert.throws(
      () => f.protection.admit({ ...f.status, boot_id: "new-boot", policyLeaseUntil: 2_000 }),
      PoolRuntimeUnhealthy,
    );
    assert.equal(f.socket.signal.aborted, true);
  } finally {
    f.socket.release();
    f.clock.advance(1_000);
    await f.background[0];
  }
});

test("recovery refuses invalid or short leases and accepts exactly 250 milliseconds", async () => {
  const f = fixture(async () => {
    throw new PoolRuntimeUnhealthy();
  });
  f.clock.advance(500);
  await f.clock.scheduled(1_000);
  try {
    for (const [deadline, reason] of [
      [undefined, "lease_invalid"],
      [NaN, "lease_invalid"],
      [Infinity, "lease_invalid"],
      [500, "lease_expired"],
      [499, "lease_expired"],
      [749, "lease_too_short"],
    ] as const)
      assert.throws(() => f.protection.admit({ ...f.status, policyLeaseUntil: deadline }), {
        reason,
      });
    assert.equal(f.socket.signal.aborted, false);
    assert.doesNotThrow(() => f.protection.admit({ ...f.status, policyLeaseUntil: 750 }));
  } finally {
    f.socket.release();
    f.clock.advance(1_000);
    await f.background[0];
  }
});

test("six active sessions admit 240 fresh requests across 40 failed probes without refusals", async () => {
  const f = fixture(async () => {
    throw new PoolRuntimeUnhealthy();
  });
  const others = Array.from({ length: 5 }, (_, index) =>
    f.streams.acquire(`http-${index}`, "pool-a", new AbortController().signal),
  );
  let refusals = 0;
  try {
    for (let round = 1; round <= 40; round++) {
      f.clock.advance(round * 500);
      await f.clock.scheduled((round + 1) * 500);
      await Promise.all(
        Array.from({ length: 6 }, async () => {
          try {
            f.protection.admit({ ...f.status, policyLeaseUntil: f.clock.time + 1_500 });
          } catch (error) {
            if (!(error instanceof PoolRuntimeUnhealthy)) throw error;
            refusals++;
          }
        }),
      );
      assert.equal(f.streams.active, 6);
    }
    assert.equal(refusals, 0);
    assert.equal(f.calls(), 40);
    assert.equal(f.closes(), 0);
    assert.ok(others.every((stream) => !stream.signal.aborted));
  } finally {
    f.socket.release();
    for (const stream of others) stream.release();
    f.clock.advance(20_500);
    await f.background[0];
  }
});

test("six active streams survive lease expiry while new admission stops and probes continue", async () => {
  const f = fixture(() => new Promise(() => {}));
  const others = Array.from({ length: 5 }, (_, index) =>
    f.streams.acquire(`http-${index}`, "pool-a", new AbortController().signal),
  );
  f.clock.advance(500);
  await f.clock.scheduled(750);
  f.clock.advance(750);
  await f.clock.scheduled(1_250);
  assert.equal(f.socket.signal.aborted, false, "one missed refresh inside the lease must not flap");
  f.clock.advance(1_250);
  await f.clock.scheduled(1_500);
  f.clock.advance(1_500);
  await f.clock.scheduled(2_000);
  assert.equal(f.socket.signal.aborted, false);
  assert.ok(others.every((stream) => !stream.signal.aborted));
  assert.equal(f.closes(), 0);
  assert.deepEqual(f.failures, [6]);
  assert.deepEqual(f.diagnostics, [
    {
      reason: "lease_expired",
      action: "preserved",
      leaseRemainingMs: 0,
      probeOutcome: "timeout",
      probeElapsedMs: 250,
    },
  ]);
  assert.throws(
    () => f.protection.admit({ ...f.status, policyLeaseUntil: 1_749 }),
    PoolRuntimeUnhealthy,
  );
  assert.equal(f.calls(), 2);
  f.socket.release();
  for (const stream of others) stream.release();
  f.clock.advance(2_000);
  await f.background[0];
});

test("a healthy renewal survives one missed probe and active stream completion stops the watcher", async () => {
  const f = fixture(async (call) =>
    call === 2
      ? new Promise(() => {})
      : {
          boot_id: "boot",
          started_at: "2026-10-31T12:00:00Z",
          policyLeaseUntil: call === 1 ? 2_000 : 3_250,
        },
  );
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

test("unhealthy readiness preserves HTTP and WebSocket streams, refuses admission and recovers on a fresh probe", async () => {
  const f = fixture(async (call) => {
    if (call === 1) throw new PoolRuntimeUnhealthy();
    return { boot_id: "boot", started_at: "fixture", policyLeaseUntil: 2_500 };
  });
  const http = f.streams.acquire("http", "pool-b", new AbortController().signal);
  f.clock.advance(500);
  await f.clock.scheduled(1_000);
  assert.equal(f.socket.signal.aborted, false);
  assert.equal(http.signal.aborted, false);
  assert.deepEqual(f.failures, [2]);
  assert.deepEqual(f.diagnostics, [
    {
      reason: "readiness_unhealthy",
      action: "preserved",
      leaseRemainingMs: 1_000,
      probeOutcome: "unhealthy",
      probeElapsedMs: 0,
    },
  ]);
  assert.throws(
    () => f.protection.admit({ ...f.status, policyLeaseUntil: 749 }),
    PoolRuntimeUnhealthy,
  );
  f.clock.advance(1_000);
  await f.clock.scheduled(1_500);
  assert.doesNotThrow(() => f.protection.admit({ ...f.status, policyLeaseUntil: 2_500 }));
  f.socket.release();
  http.release();
  f.clock.advance(1_500);
  await f.background[0];
});

test("a proven boot change still closes HTTP and WebSocket streams", async () => {
  const f = fixture(async () => ({
    boot_id: "new-boot",
    started_at: "fixture",
    policyLeaseUntil: 2_000,
  }));
  const http = f.streams.acquire("http", "pool-b", new AbortController().signal);
  f.clock.advance(500);
  await f.background[0];
  assert.equal(f.socket.signal.aborted, true);
  assert.equal(http.signal.aborted, true);
  assert.deepEqual(f.failures, [2]);
  assert.deepEqual(f.diagnostics, [
    {
      reason: "boot_changed",
      action: "closed",
      leaseRemainingMs: 1_000,
      probeOutcome: "healthy",
      probeElapsedMs: 0,
    },
  ]);
});

test("a missing, expired or malformed lease cannot admit a native stream", async () => {
  const f = fixture(() => new Promise(() => {}));
  for (const deadline of [undefined, NaN, 0])
    assert.throws(
      () => f.protection.admit({ ...f.status, policyLeaseUntil: deadline }),
      PoolRuntimeUnhealthy,
    );
  f.socket.release();
  f.clock.advance(500);
  await f.background[0];
});

test("transport delay consumes the container lease rather than extending it", async () => {
  let now = 10;
  const readiness = {
    fetch: async () => {
      now = 510;
      return Response.json(
        { boot_id: "boot", started_at: "2026-10-31T12:00:00Z" },
        {
          headers: { [policyHealthHeader]: "1000" },
        },
      );
    },
  };
  const status = await readRuntimeHealth(
    readiness,
    "fixture",
    new AbortController().signal,
    () => now,
  );
  assert.equal(status.policyLeaseUntil, 1_010);
  for (const value of ["0", "1501", "invalid"]) {
    const invalid = await readRuntimeHealth(
      {
        fetch: async () =>
          Response.json(
            { boot_id: "boot", started_at: "now" },
            {
              headers: { [policyHealthHeader]: value },
            },
          ),
      },
      "fixture",
      new AbortController().signal,
    );
    assert.equal(invalid.policyLeaseUntil, undefined);
  }
});
