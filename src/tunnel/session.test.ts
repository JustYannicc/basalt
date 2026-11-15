import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { decodeTunnelFrame, tunnelLimits } from "../../clients/contracts/tunnel.ts";
import { serveTunnel } from "./session.ts";
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
