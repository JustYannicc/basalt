import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { decodeTunnelFrame, tunnelLimits } from "../../clients/contracts/tunnel.ts";
import { leaseLostLimitMs, serveTunnel } from "./session.ts";
import type { TunnelSocket } from "./platform.ts";

class Peer extends EventTarget implements TunnelSocket {
  binaryType: BinaryType = "arraybuffer";
  sent: string[] = [];
  closed: number[] = [];
  accept() {}
  send(data: Parameters<WebSocket["send"]>[0]) {
    assert.equal(typeof data, "string");
    this.sent.push(String(data));
  }
  close(code = 1000) {
    this.closed.push(code);
    this.dispatchEvent(new Event("close"));
  }
  frame(value: object) {
    this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify({ v: 1, ...value }) }));
  }
}

function session(context: TestContext, lifetime = 3_600_000) {
  const now = 1_800_000_000_000;
  context.mock.timers.enable({ apis: ["Date", "setTimeout"], now });
  const socket = new Peer();
  const lease = new Peer();
  let arrive!: (request: Request) => void;
  const dispatched = new Promise<Request>((resolve) => {
    arrive = resolve;
  });
  let headers!: (response: Response) => void;
  const upstream = new Promise<Response>((resolve) => {
    headers = resolve;
  });
  const work: Promise<unknown>[] = [];
  let calls = 0;
  const access = {
    id: "native:synthetic-session",
    userId: "synthetic-person",
    clientId: "synthetic-client",
    expiresAt: now + lifetime,
    policy: {
      kind: "native" as const,
      computer: "synthetic-computer",
      pool: "synthetic-pool",
      models: true,
    },
  };
  serveTunnel(
    socket,
    lease,
    new Request("https://router.example/native/v1/tunnel", {
      headers: { authorization: "Bearer synthetic-native" },
    }),
    {
      POOL_APP_SIGNING_KEY: "ab".repeat(32),
      TOOLS_SERVICE: { fetch: async () => Response.json(access) },
      POOL_SERVICE: {
        fetch: (request) => {
          calls++;
          arrive(request);
          return upstream;
        },
      },
    },
    access,
    (pending) => work.push(pending),
  );
  context.after(() => lease.close());
  socket.frame({
    type: "open",
    id: 1,
    operation: { service: "models", method: "POST", path: "/v1/responses", transport: "http" },
    headers: { "content-type": "application/json" },
  });
  socket.frame({ type: "credit", id: 1, bytes: tunnelLimits.windowBytes });
  socket.frame({ type: "data", id: 1, bytes: Buffer.from("{}").toString("base64"), text: false });
  socket.frame({ type: "end", id: 1 });
  return {
    socket,
    lease,
    dispatched,
    headers,
    work,
    expiresAt: access.expiresAt,
    calls: () => calls,
    frames: () => socket.sent.map((frame) => decodeTunnelFrame(frame, "server")),
  };
}

test("a model can think beyond ten minutes and deliver its terminal within the grant", async (context) => {
  const fixture = session(context);
  const request = await fixture.dispatched;
  context.mock.timers.tick(600_001);
  fixture.headers(
    new Response(
      new TextEncoder().encode(
        'event: response.completed\ndata: {"type":"response.completed"}\n\n',
      ),
      {
        headers: { "content-type": "text/event-stream" },
      },
    ),
  );
  await fixture.work[1];
  assert.equal(request.signal.aborted, true, "The finished operation releases its request");
  assert.deepEqual(fixture.socket.closed, []);
  const frames = fixture.frames();
  const ready = frames.find((frame) => frame.type === "ready");
  assert.ok(ready?.type === "ready");
  assert.deepEqual(
    ready.limits,
    tunnelLimits,
    "Installed clients require the original READY limits",
  );
  assert.equal(ready.expiresAt, fixture.expiresAt);
  assert.equal(frames.at(-1)?.type, "end");
  const body = frames.flatMap((frame) =>
    frame.type === "data" ? [Buffer.from(frame.bytes, "base64")] : [],
  );
  assert.match(Buffer.concat(body).toString(), /response\.completed/);
  assert.equal(fixture.calls(), 1, "Long thinking must never replay inference");
});

for (const reason of ["grant expiry", "revocation", "cancellation"] as const)
  test(`${reason} still cancels a thinking model without replay`, async (context) => {
    const fixture = session(context, 300_000);
    const request = await fixture.dispatched;
    if (reason === "grant expiry") context.mock.timers.tick(300_000);
    else if (reason === "revocation") fixture.lease.close();
    else fixture.socket.frame({ type: "cancel", id: 1 });
    assert.equal(request.signal.aborted, true);
    fixture.headers(new Response(new TextEncoder().encode("must not arrive")));
    await fixture.work[1];
    assert.equal(
      fixture.frames().some((frame) => frame.type === "data" || frame.type === "end"),
      false,
    );
    assert.equal(fixture.calls(), 1);
    if (reason === "grant expiry") assert.equal(fixture.socket.closed[0], 1008);
  });

test("a long-valid grant does not overflow the platform timer and close early", async (context) => {
  const fixture = session(context, 31 * 86_400_000);
  await fixture.dispatched;
  context.mock.timers.tick(2_147_483_647);
  assert.deepEqual(fixture.socket.closed, []);
  context.mock.timers.tick(31 * 86_400_000 - 2_147_483_647);
  assert.equal(fixture.socket.closed[0], 1008);
  fixture.headers(new Response(null));
  await fixture.work[1];
  assert.equal(fixture.calls(), 1);
});

// As workerd reports a lease whose holder's instance went away: no Close frame, code 1006.
const wentAway = (lease: EventTarget) =>
  lease.dispatchEvent(Object.assign(new Event("close"), { code: 1006, wasClean: false }));

test("a session whose lease went away ends once its calls end, with one closed line", async (context) => {
  const warned = context.mock.method(console, "warn", () => {});
  const fixture = session(context);
  const request = await fixture.dispatched;
  wentAway(fixture.lease);
  assert.equal(request.signal.aborted, false, "the call under way goes on");
  assert.deepEqual(fixture.socket.closed, []);
  context.mock.timers.tick(5_000);
  fixture.headers(
    new Response(
      new TextEncoder().encode(
        'event: response.completed\ndata: {"type":"response.completed"}\n\n',
      ),
      {
        headers: { "content-type": "text/event-stream" },
      },
    ),
  );
  await fixture.work[1];
  assert.equal(fixture.frames().at(-1)?.type, "end");
  assert.deepEqual(fixture.socket.closed, [1000]);
  const lines = warned.mock.calls.filter(
    (call) => call.arguments[0] === "NATIVE_TUNNEL_LEASE_LOST",
  );
  assert.deepEqual(
    lines.map((call) => call.arguments[1]),
    [{ cause: "went_away", code: 1006, operations: 1, ended: "operations", heldMs: 5_000 }],
  );
});

test(`a session whose lease went away ends after ${leaseLostLimitMs} ms at most`, async (context) => {
  const warned = context.mock.method(console, "warn", () => {});
  const fixture = session(context);
  const request = await fixture.dispatched;
  fixture.lease.dispatchEvent(new Event("error"));
  context.mock.timers.tick(leaseLostLimitMs - 1);
  assert.deepEqual(fixture.socket.closed, []);
  assert.equal(request.signal.aborted, false);
  context.mock.timers.tick(1);
  assert.deepEqual(fixture.socket.closed, [1011]);
  assert.equal(request.signal.aborted, true, "the call is stopped with the session");
  assert.deepEqual(
    warned.mock.calls
      .filter((call) => call.arguments[0] === "NATIVE_TUNNEL_LEASE_LOST")
      .map((call) => call.arguments[1]),
    [{ cause: "error", code: null, operations: 1, ended: "bound", heldMs: leaseLostLimitMs }],
  );
});

test("a session whose lease went away refuses a new call, and drops the body the device already sent", async (context) => {
  context.mock.method(console, "warn", () => {});
  const fixture = session(context);
  await fixture.dispatched;
  wentAway(fixture.lease);
  fixture.socket.frame({
    type: "open",
    id: 2,
    operation: { service: "models", method: "POST", path: "/v1/responses", transport: "http" },
    headers: { "content-type": "application/json" },
  });
  fixture.socket.frame({ type: "credit", id: 2, bytes: tunnelLimits.windowBytes });
  fixture.socket.frame({
    type: "data",
    id: 2,
    bytes: Buffer.from("{}").toString("base64"),
    text: false,
  });
  fixture.socket.frame({ type: "end", id: 2 });
  assert.deepEqual(
    fixture.frames().filter((frame) => "id" in frame && frame.id === 2),
    [{ v: 1, type: "error", id: 2, code: "unavailable", outcome: "not-started" }],
  );
  assert.equal(fixture.calls(), 1, "nothing new reached the pool");
  assert.deepEqual(fixture.socket.closed, [], "the session stays for the call under way");
});

test("a close the pool sends ends the session and its calls at once, with one line", async (context) => {
  const warned = context.mock.method(console, "warn", () => {});
  const fixture = session(context);
  const request = await fixture.dispatched;
  fixture.lease.dispatchEvent(Object.assign(new Event("close"), { code: 1000, wasClean: true }));
  assert.equal(request.signal.aborted, true);
  assert.deepEqual(fixture.socket.closed, [1000]);
  assert.deepEqual(
    warned.mock.calls.map((call) => call.arguments),
    [["NATIVE_TUNNEL_LEASE_CLOSED", { code: 1000, clean: true, operations: 1 }]],
  );
});

test("a lease error and the close after it are one loss, with the close's code", async (context) => {
  const warned = context.mock.method(console, "warn", () => {});
  const fixture = session(context);
  await fixture.dispatched;
  fixture.lease.dispatchEvent(new Event("error"));
  wentAway(fixture.lease);
  assert.deepEqual(fixture.socket.closed, []);
  context.mock.timers.tick(leaseLostLimitMs);
  const [line] = warned.mock.calls.filter(
    (call) => call.arguments[0] === "NATIVE_TUNNEL_LEASE_LOST",
  );
  assert.deepEqual(line?.arguments[1], {
    cause: "error",
    code: 1006,
    operations: 1,
    ended: "bound",
    heldMs: leaseLostLimitMs,
  });
});
