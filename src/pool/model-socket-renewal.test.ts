import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { NativeMemberships } from "./membership.ts";
import {
  membershipTtlMs,
  modelSocketRenewalLeadMs,
  modelSocketRenewalReason as socketRenewalReason,
  modelUseAssertionTtlMs,
  policyHeader,
  policyUsePrefix,
} from "./membership-contract.ts";
import { modelLifetimePath, modelLifetimeProtocol } from "./model-lifetime-contract.ts";
import { openEnvelope } from "./token.ts";
import {
  membershipGraceFixture,
  membershipSigningKey as key,
} from "../../scripts/pool-tests/membership-grace-fixture.ts";

// Worker modules load at runtime only; their platform types stay out of this Node test.
const workerModule = "./forward.worker.ts";
const { forwardPoolRequest } = (await import(workerModule)) as {
  forwardPoolRequest(request: Request, port: 8317, dependencies: object): Promise<Response>;
};

type Closed = { code: number; reason: string };

class Socket extends EventTarget {
  peer?: Socket;
  closed?: Closed;
  onAccept?: () => void;
  accept() {
    this.onAccept?.();
  }
  send(data: unknown) {
    if (this.closed || this.peer?.closed) throw new Error("Closed socket");
    this.peer!.dispatchEvent(new MessageEvent("message", { data }));
  }
  close(code = 1000, reason = "") {
    if (this.closed) return;
    this.closed = { code, reason };
    this.dispatchEvent(Object.assign(new Event("close"), { code, reason }));
    if (this.peer && !this.peer.closed) this.peer.close(code, reason);
  }
}
class Pair {
  0 = new Socket();
  1 = new Socket();
  constructor() {
    this[0].peer = this[1];
    this[1].peer = this[0];
  }
}
const NodeResponse = Response;
class EdgeResponse extends NodeResponse {
  readonly webSocket?: Socket;
  constructor(body: BodyInit | null, init: ResponseInit & { webSocket?: Socket } = {}) {
    super(body, { ...init, status: init.status === 101 ? 200 : init.status });
    if (init.status === 101) Object.defineProperty(this, "status", { value: 101 });
    this.webSocket = init.webSocket;
  }
}

const create = '{"type":"response.create","input":[]}';
const completed = '{"type":"response.completed","response":{"status":"completed"}}';
const refusal = '{"type":"error","error":{"message":"native policy assertion is invalid"}}';
const renewAfterMs = modelUseAssertionTtlMs - modelSocketRenewalLeadMs;
const session = "00000000-0000-4000-8000-ffffffffffff";
// The relay adds the turn sequence to the session's low 48 bits, so turn one wraps to zero.
const firstTurn = "00000000-0000-4000-8000-000000000000";

async function harness(t: TestContext, observing: boolean) {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "WebSocketPair");
  Object.defineProperty(globalThis, "WebSocketPair", { configurable: true, value: Pair });
  t.after(() => {
    if (descriptor) Object.defineProperty(globalThis, "WebSocketPair", descriptor);
    else Reflect.deleteProperty(globalThis, "WebSocketPair");
  });
  t.mock.method(globalThis, "Response", EdgeResponse);
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: Date.now() });
  t.mock.method(crypto, "randomUUID", () => session);
  const f = membershipGraceFixture();
  const memberships = new NativeMemberships(f.dependencies);
  await memberships.ensure("pool", "organization");
  const finishes: string[] = [];
  const background: unknown[] = [];
  let auto = true;
  const dependencies = {
    env: {
      POOL_APP_SIGNING_KEY: key,
      ...(observing ? { POOL_MODEL_HISTORY_ENABLED: "true" } : {}),
    },
    appModel: { pool: "pool", person: "person", keyId: 1 },
    memberships,
    streams: f.streams,
    protection: { admit() {} },
    computers: { observeUsage: async () => {} },
    lifecycle: Promise.resolve({ warm: async () => ({ boot_id: "fixture" }) }),
    ...(observing
      ? {
          terminal: {
            start: async () => {},
            finish: async (_id: string, value: { outcome: string }) => {
              finishes.push(value.outcome);
            },
          },
        }
      : {}),
    defer: (work: unknown) => {
      background.push(work);
    },
    fetch: async (request: Request) => {
      if (new URL(request.url).pathname === modelLifetimePath) {
        const control = new Pair();
        control[0].onAccept = () => control[1].send("ready");
        return new EdgeResponse(null, {
          status: 101,
          webSocket: control[0],
          headers: { "Sec-WebSocket-Protocol": modelLifetimeProtocol },
        });
      }
      const upstream = new Pair();
      // A vetoed lifetime aborts the upgrade; the runtime then ends the pool socket.
      request.signal.addEventListener("abort", () => upstream[1].close(1011, "Upstream aborted"));
      const socket = { outbound: [] as unknown[], refused: [] as boolean[] };
      const assertion = request.headers.get(policyHeader);
      const { expiresAt } = (await openEnvelope(key, policyUsePrefix, assertion!)) as {
        expiresAt: number;
      };
      // Like the pool, every turn on this socket is checked against its upgrade assertion.
      upstream[1].addEventListener("message", (event) => {
        const refused = Date.now() > expiresAt;
        socket.outbound.push((event as MessageEvent).data);
        socket.refused.push(refused);
        if (refused) upstream[1].send(refusal);
        else if (auto) upstream[1].send(completed);
      });
      sockets.push({ ...socket, assertion, expiresAt, upstream: upstream[1] });
      return new EdgeResponse(null, {
        status: 101,
        webSocket: upstream[0],
        headers: observing ? { "X-Basalt-Terminal-Protocol": "1" } : {},
      });
    },
  };
  const sockets: {
    assertion: string | null;
    expiresAt: number;
    upstream: Socket;
    outbound: unknown[];
    refused: boolean[];
  }[] = [];
  const connect = async () => {
    const response = await forwardPoolRequest(
      new Request("https://pool.invalid/v1/responses", { headers: { Upgrade: "websocket" } }),
      8317,
      dependencies,
    );
    if (response.status !== 101) return { response };
    const pool = sockets.at(-1)!;
    const client = (response as EdgeResponse).webSocket!;
    const delivered: unknown[] = [];
    client.addEventListener("message", (event) => delivered.push((event as MessageEvent).data));
    return { response, client, delivered, pool, expiresAt: pool.expiresAt };
  };
  return {
    f,
    memberships,
    finishes,
    connect,
    manual: () => {
      auto = false;
    },
    drain: () => Promise.all(background),
    tick: (ms: number) => t.mock.timers.tick(ms),
    setTime: (ms: number) => t.mock.timers.setTime(ms),
  };
}

test("with observation off, a held socket renews between turns and the reconnect keeps working", async (t) => {
  const h = await harness(t, false);
  const a = await h.connect();
  assert.ok(a.client);
  a.client.send(create);
  h.tick(renewAfterMs - 1_000);
  a.client.send(create);
  assert.deepEqual(a.delivered, [completed, completed]);
  assert.equal(a.client.closed, undefined);
  h.tick(1_000);
  assert.deepEqual(a.client.closed, { code: 1000, reason: socketRenewalReason });
  assert.ok(a.pool.upstream.closed);
  const b = await h.connect();
  assert.ok(b.client && b.expiresAt > a.expiresAt);
  b.client.send(create);
  assert.deepEqual(b.delivered, [completed]);
  assert.deepEqual([a.pool.refused, b.pool.refused], [[false, false], [false]]);
  b.client.close();
});

test("a turn in flight at the renewal time completes before the socket closes", async (t) => {
  const h = await harness(t, true);
  h.manual();
  const a = await h.connect();
  assert.ok(a.client);
  a.client.send(create);
  a.pool.upstream.send(JSON.stringify({ type: "basalt.request_started", request_id: firstTurn }));
  h.tick(renewAfterMs + 1_000);
  assert.equal(a.client.closed, undefined);
  a.pool.upstream.send(completed);
  assert.deepEqual(a.delivered, [completed]);
  assert.deepEqual(a.client.closed, { code: 1000, reason: socketRenewalReason });
  await h.drain();
  assert.deepEqual(h.finishes, ["complete"]);
});

/** The client's side of a renewal: the socket closed cleanly, and the turn succeeds on a new one. */
async function resend(h: Awaited<ReturnType<typeof harness>>) {
  const fresh = await h.connect();
  assert.ok(fresh.client);
  fresh.client.send(create);
  fresh.pool.upstream.send(completed);
  assert.deepEqual(fresh.delivered, [completed]);
  return fresh;
}

for (const late of ["renewal", "expiry"] as const)
  test(`an idle socket never forwards a turn sent after ${late}; the resend succeeds`, async (t) => {
    const h = await harness(t, true);
    h.manual();
    const a = await h.connect();
    assert.ok(a.client);
    // setTime moves the clock without running due timers, so the turn reaches the relay first.
    h.setTime(late === "renewal" ? a.expiresAt - modelSocketRenewalLeadMs : a.expiresAt + 1);
    a.client.send(create);
    assert.deepEqual(a.pool.outbound, []);
    assert.deepEqual(a.client.closed, { code: 1000, reason: socketRenewalReason });
    const b = await resend(h);
    assert.deepEqual([a.pool.refused, b.pool.refused], [[], [false]]);
  });

for (const late of ["renewal", "expiry"] as const)
  test(`beside a live turn, a turn sent after ${late} waits for a fresh socket and nothing is cut`, async (t) => {
    const h = await harness(t, true);
    h.manual();
    const a = await h.connect();
    assert.ok(a.client);
    a.client.send(create);
    h.tick(renewAfterMs + 1_000);
    if (late === "expiry") h.setTime(a.expiresAt + 1);
    a.client.send(create);
    assert.equal(a.pool.outbound.length, 1);
    assert.equal(a.client.closed, undefined);
    a.pool.upstream.send(completed);
    assert.deepEqual(a.delivered, [completed]);
    assert.deepEqual(a.client.closed, { code: 1000, reason: socketRenewalReason });
    const b = await resend(h);
    assert.deepEqual([a.pool.refused, b.pool.refused], [[false], [false]]);
  });

test("an error before a turn's failure does not renew the socket under another live turn", async (t) => {
  const h = await harness(t, false);
  h.manual();
  const a = await h.connect();
  assert.ok(a.client);
  a.client.send(create);
  a.client.send(create);
  h.tick(renewAfterMs + 1_000);
  a.pool.upstream.send('{"type":"error","error":{"message":"failed"}}');
  a.pool.upstream.send('{"type":"response.failed","response":{"status":"failed"}}');
  assert.equal(a.client.closed, undefined);
  a.pool.upstream.send(completed);
  assert.deepEqual(a.client.closed, { code: 1000, reason: socketRenewalReason });
});

test("a removed membership still closes a held socket and refuses its reconnect", async (t) => {
  const h = await harness(t, false);
  const a = await h.connect();
  assert.ok(a.client);
  a.client.send(create);
  h.f.select([]);
  h.f.fault("reconcile");
  h.f.advance(membershipTtlMs + 1);
  await assert.rejects(h.memberships.ensure("pool", "organization"));
  assert.equal(a.client.closed?.code, 1011);
  const b = await h.connect();
  assert.notEqual(b.response.status, 101);
  await b.response.body?.cancel();
});
