import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { mobileController } from "../mobile/controller.ts";

const now = 1_800_000_000_000;
async function advance(t: TestContext, milliseconds: number) {
  // Tick each millisecond so promise continuations can install their next fake timer.
  for (let elapsed = 0; elapsed < milliseconds; elapsed += 50) {
    t.mock.timers.tick(Math.min(50, milliseconds - elapsed));
    for (let turn = 0; turn < 30; turn++) await Promise.resolve();
  }
}
function fixture(t: TestContext) {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now });
  t.mock.method(performance, "now", () => Date.now() - now);
  t.mock.method(Math, "random", () => 0.5);
  let networkChanged: ((online: boolean) => void) | undefined;
  let online = true;
  let status = 200;
  let reads = 0;
  const times: number[] = [];
  let retryAfter: string | undefined;
  let held: Promise<void> | undefined;
  let inFlight = 0;
  let maximum = 0;
  t.mock.method(globalThis, "fetch", async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    if (url.pathname === "/") return new Response(null, { status: online ? 200 : 503 });
    assert.equal(url.pathname, "/api/auth/native/access");
    reads++;
    times.push(Date.now());
    inFlight++;
    maximum = Math.max(maximum, inFlight);
    try {
      if (held) {
        await new Promise<void>((resolve, reject) => {
          const abort = () => reject(init?.signal?.reason);
          init?.signal?.addEventListener("abort", abort, { once: true });
          void held!
            .then(resolve, reject)
            .finally(() => init?.signal?.removeEventListener("abort", abort));
          if (init?.signal?.aborted) abort();
        });
      }
      if (!online) throw new TypeError("Synthetic offline network");
      if (status !== 200)
        return new Response(null, {
          status,
          headers: retryAfter ? { "Retry-After": retryAfter } : {},
        });
      return Response.json({
        id: "native:fixture",
        userId: "fixture-user",
        clientId: "fixture-client",
        policy: {
          kind: "native",
          models: true,
          toolsOrganization: "fixture-tools",
          computer: "fixture-phone",
          pool: "fixture-pool",
        },
        expiresAt: now + 3_600_000,
      });
    } finally {
      inFlight--;
    }
  });
  let saved: string | undefined = JSON.stringify({
    version: 1,
    mode: "device",
    origin: "https://fixture.example.test",
    clientId: "fixture-client",
    accessToken: "fixture-access",
    refreshToken: "fixture-refresh",
    expiresAt: now + 3_600_000,
  });
  const controller = mobileController({
    store: {
      read: async () => saved,
      write: async (value) => {
        saved = value;
      },
      remove: async () => {
        saved = undefined;
      },
    },
    network: {
      subscribe: (changed) => {
        networkChanged = changed;
        return () => {
          networkChanged = undefined;
        };
      },
    },
    socket: () => {
      throw new Error("No application operation should be replayed");
    },
    crypto: { randomBytes: () => new Uint8Array(32), sha256: async () => new Uint8Array(32) },
    openApproval: async () => {},
    closeApproval: () => {},
  });
  return {
    controller,
    times,
    offline: () => {
      online = false;
    },
    online: () => {
      online = true;
    },
    status: (value: number, retry?: string) => {
      status = value;
      retryAfter = retry;
    },
    hold: (value: Promise<void> | undefined) => {
      held = value;
    },
    notifyNetwork: (value: boolean) => networkChanged?.(value),
    reads: () => reads,
    maximum: () => maximum,
  };
}

test("a phone foregrounded offline recovers after a twenty-second outage without user action", async (t) => {
  const f = fixture(t);
  await f.controller.initialize();
  await f.controller.foreground(false);
  f.offline();
  const resumed = f.controller.foreground(true);
  await advance(t, 20_000);
  await resumed;
  assert.equal(f.controller.getSnapshot().connection?.capabilities.length, 0);
  f.online();
  await advance(t, 30_000);
  assert.deepEqual(f.controller.getSnapshot().connection?.capabilities, ["models", "tools"]);
  assert.equal(f.controller.getSnapshot().error, undefined);
  const transport = await f.controller.run(
    (source, signal) => source.transport(signal),
    new AbortController().signal,
  );
  assert.equal(transport.mode, "device");
  await f.controller.foreground(false);
});

test("online network and health transitions reconnect immediately during backoff", async (t) => {
  const f = fixture(t);
  await f.controller.initialize();
  await f.controller.foreground(false);
  f.offline();
  const resumed = f.controller.foreground(true);
  await advance(t, 20_000);
  await resumed;
  f.online();
  const before = f.reads();
  f.notifyNetwork(true);
  await advance(t, 50);
  assert.equal(f.reads(), before + 1);
  assert.deepEqual(f.controller.getSnapshot().connection?.capabilities, ["models", "tools"]);

  f.offline();
  const health = f.controller.checkHealth();
  await advance(t, 2000);
  await health;
  assert.equal(f.controller.getSnapshot().reconnecting, true);
  // Health's ten-second cache expires while automatic recovery is backing off.
  await advance(t, 10_000);
  f.online();
  const checked = f.controller.checkHealth();
  await advance(t, 50);
  await checked;
  assert.equal(f.controller.getSnapshot().reconnecting, false);
  assert.equal(f.controller.getSnapshot().error, undefined);
  await f.controller.close();
});

test("a deploy-window 503 respects Retry-After and restores usable access", async (t) => {
  const f = fixture(t);
  await f.controller.initialize();
  f.status(503, "20");
  const resumed = f.controller.foreground(true);
  await advance(t, 19_000);
  assert.equal(f.reads(), 2);
  f.status(200);
  await advance(t, 1050);
  await resumed;
  assert.ok(f.times[2]! - f.times[1]! >= 20_000);
  assert.deepEqual(f.controller.getSnapshot().connection?.capabilities, ["models", "tools"]);
  assert.equal(f.controller.getSnapshot().error, undefined);
  await f.controller.close();
});

test("a definitive 401 requires sign-in and never loops on timers or online events", async (t) => {
  const f = fixture(t);
  await f.controller.initialize();
  f.status(401);
  await f.controller.foreground(true);
  assert.equal(f.controller.getSnapshot().connection?.state, "sign-in-required");
  assert.match(f.controller.getSnapshot().error!, /Sign in again/u);
  assert.equal(f.controller.getSnapshot().reconnecting, false);
  const reads = f.reads();
  f.notifyNetwork(true);
  await f.controller.checkHealth();
  await f.controller.foreground(true);
  await advance(t, 120_000);
  assert.equal(f.reads(), reads);
  await f.controller.close();
});

test("resume, network, health and manual recovery share one in-flight attempt", async (t) => {
  const f = fixture(t);
  await f.controller.initialize();
  let release!: () => void;
  f.hold(
    new Promise<void>((resolve) => {
      release = resolve;
    }),
  );
  const attempts = [
    f.controller.foreground(true),
    f.controller.foreground(true),
    f.controller.reconnect(),
    f.controller.checkHealth(),
  ];
  f.notifyNetwork(true);
  f.notifyNetwork(false);
  await advance(t, 1000);
  release();
  await advance(t, 100);
  await Promise.all(attempts);
  assert.equal(f.maximum(), 1);
  await f.controller.close();
});

test("disconnect and backgrounding cancel retries without replaying work", async (t) => {
  const f = fixture(t);
  await f.controller.initialize();
  f.offline();
  const resumed = f.controller.foreground(true);
  await advance(t, 2000);
  await resumed;
  await f.controller.disconnect();
  const reads = f.reads();
  await f.controller.foreground(false);
  await f.controller.foreground(true);
  f.online();
  f.notifyNetwork(true);
  await advance(t, 60_000);
  assert.equal(f.reads(), reads);
  assert.equal(f.controller.getSnapshot().connection?.state, "disconnected");
  await f.controller.reconnect();
  assert.equal(f.controller.getSnapshot().reconnecting, false);
  assert.deepEqual(f.controller.getSnapshot().connection?.capabilities, ["models", "tools"]);
  await f.controller.close();
});

test("a rapid background and foreground transition does not lose recovery", async (t) => {
  const f = fixture(t);
  await f.controller.initialize();
  f.hold(new Promise<void>(() => {}));
  const reconnecting = f.controller.foreground(true);
  await advance(t, 50);
  const background = f.controller.foreground(false);
  f.hold(undefined);
  const foreground = f.controller.foreground(true);
  await advance(t, 50);
  await Promise.all([reconnecting, background, foreground]);
  assert.equal(f.maximum(), 1);
  assert.equal(f.controller.getSnapshot().reconnecting, false);
  assert.deepEqual(f.controller.getSnapshot().connection?.capabilities, ["models", "tools"]);
  await f.controller.close();
});
