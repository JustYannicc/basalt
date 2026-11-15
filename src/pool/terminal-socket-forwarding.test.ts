import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";

const workerModule = "./forward.worker.ts";
const {
  forwardPoolRequest,
}: {
  forwardPoolRequest(request: Request, port: 8317, dependencies: object): Promise<Response>;
} = await import(workerModule);

class Socket extends EventTarget {
  peer?: Socket;
  closed = false;
  accept() {}
  send(data: unknown) {
    if (this.closed || this.peer?.closed) throw new Error("Closed socket");
    this.peer!.dispatchEvent(new MessageEvent("message", { data }));
  }
  close(code = 1000, reason = "") {
    if (this.closed) return;
    this.closed = true;
    this.dispatchEvent(Object.assign(new Event("close"), { code, reason }));
    if (this.peer && !this.peer.closed) {
      this.peer.closed = true;
      this.peer.dispatchEvent(Object.assign(new Event("close"), { code, reason }));
    }
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
    const options = { ...init };
    if (options.status === 101) options.status = 200;
    super(body, options);
    if (init.status === 101) Object.defineProperty(this, "status", { value: 101 });
    this.webSocket = init.webSocket;
  }
}
const session = "00000000-0000-4000-8000-ffffffffffff";
const first = "00000000-0000-4000-8000-000000000000";
const second = "00000000-0000-4000-8000-000000000001";

async function fixture(t: TestContext, acknowledged = true, framed = false) {
  const pairDescriptor = Object.getOwnPropertyDescriptor(globalThis, "WebSocketPair");
  Object.defineProperty(globalThis, "WebSocketPair", { configurable: true, value: Pair });
  t.after(() => {
    if (pairDescriptor) Object.defineProperty(globalThis, "WebSocketPair", pairDescriptor);
    else Reflect.deleteProperty(globalThis, "WebSocketPair");
  });
  t.mock.method(globalThis, "Response", EdgeResponse);
  t.mock.method(crypto, "randomUUID", () => session);
  const upstream = new Pair();
  const starts: Record<string, unknown>[] = [],
    finishes: Record<string, unknown>[] = [];
  const background: Promise<unknown>[] = [],
    delivered: unknown[] = [],
    outbound: unknown[] = [];
  const response = await forwardPoolRequest(
    new Request("https://pool.invalid/v1/responses", {
      headers: { Upgrade: "websocket", "X-Basalt-Request-Id": "spoofed" },
    }),
    8317,
    {
      env: { POOL_APP_SIGNING_KEY: "fixture" },
      appModel: { pool: "fixture", person: "fixture-person", keyId: 1 },
      memberships: { configured: async () => false },
      streams: {},
      protection: {},
      computers: { observeUsage: async () => {} },
      lifecycle: Promise.resolve({ warm: async () => ({ boot_id: "fixture" }) }),
      terminal: {
        start: async (value: Record<string, unknown>) => {
          starts.push(value);
        },
        finish: async (id: string, value: Record<string, unknown>) => {
          finishes.push({ requestId: id, ...value });
        },
      },
      fetch: async (request: Request) => {
        assert.equal(request.headers.get("X-Basalt-Request-Id"), session);
        return new EdgeResponse(null, {
          status: 101,
          webSocket: upstream[0],
          headers: {
            ...(acknowledged ? { "X-Basalt-Terminal-Protocol": "1" } : {}),
            ...(framed ? { "sec-websocket-protocol": "basalt.model-drain.v1" } : {}),
          },
        });
      },
      defer: (work: Promise<unknown>) => {
        background.push(work);
      },
    },
  );
  const client = (response as EdgeResponse).webSocket!;
  client.addEventListener("message", (event) => delivered.push((event as MessageEvent).data));
  upstream[1].addEventListener("message", (event) => outbound.push((event as MessageEvent).data));
  return {
    client,
    upstream: upstream[1],
    starts,
    finishes,
    delivered,
    outbound,
    response,
    drain: async () => {
      await Promise.all(background);
    },
  };
}

test("two model requests on one socket retain distinct joins and no private metadata reaches the client", async (t) => {
  const f = await fixture(t);
  const one = '{"type":"response.create","input":"private-one"}',
    two = '{"type":"response.append","input":"private-two"}';
  f.client.send(one);
  f.client.send(two);
  f.upstream.send(JSON.stringify({ type: "basalt.request_started", request_id: first }));
  f.upstream.send('{"type":"response.created","response":{"id":"response-one"}}');
  f.upstream.send(
    '{"type":"response.completed","response":{"id":"response-one","status":"completed"}}',
  );
  f.upstream.send(JSON.stringify({ type: "basalt.request_started", request_id: second }));
  f.upstream.send('{"type":"response.failed","response":{"id":"response-two","status":"failed"}}');
  f.client.close();
  await f.drain();
  assert.deepEqual(f.starts.map((value) => value.requestId).sort(), [first, second]);
  assert.deepEqual(f.finishes.map((value) => [value.requestId, value.outcome]).sort(), [
    [first, "complete"],
    [second, "provider_failed"],
  ]);
  assert.deepEqual(f.outbound, [one, two]);
  assert.equal(f.delivered.length, 3);
  assert.doesNotMatch(JSON.stringify(f.delivered), /basalt.request_started/);
  assert.equal(f.response.headers.get("X-Basalt-Terminal-Protocol"), null);
  assert.doesNotMatch(JSON.stringify([f.starts, f.finishes]), /private-/);
});

test("a skipped websocket input cannot steal a later request's successful terminal", async (t) => {
  const f = await fixture(t);
  f.client.send('{"type":"response.create","input":"skipped"}');
  f.client.send('{"type":"response.create","input":"delivered"}');
  f.upstream.send(JSON.stringify({ type: "basalt.request_started", request_id: second }));
  f.upstream.send(
    '{"type":"response.completed","response":{"id":"response-two","status":"completed"}}',
  );
  f.upstream.close();
  await f.drain();
  assert.deepEqual(f.finishes.map((value) => [value.requestId, value.outcome]).sort(), [
    [first, "truncated"],
    [second, "complete"],
  ]);
});

test("closing an idle socket creates no request", async (t) => {
  const idle = await fixture(t);
  idle.client.close();
  await idle.drain();
  assert.deepEqual(idle.starts, []);
  assert.deepEqual(idle.finishes, []);
});

test("closing a websocket after dispatch records client closure", async (t) => {
  const active = await fixture(t);
  active.client.send('{"type":"response.create"}');
  active.client.close();
  await active.drain();
  assert.equal(active.finishes.length, 1);
  assert.partialDeepStrictEqual(active.finishes[0], {
    requestId: first,
    outcome: "client_closed",
    status: 499,
  });
});

test("an older websocket producer stays unavailable rather than inventing a join", async (t) => {
  const f = await fixture(t, false);
  f.client.send('{"type":"response.create"}');
  f.upstream.send('{"type":"response.completed","response":{"status":"completed"}}');
  f.client.close();
  await f.drain();
  assert.equal(f.finishes.length, 1);
  assert.equal(f.finishes[0]!.outcome, "unavailable");
});

test("the websocket counter matches the producer's first root type and ASCII whitespace rules", async (t) => {
  const f = await fixture(t);
  f.client.send('{"TYPE":"response.create"}');
  f.client.send('{"type":"response.create","type":"response.cancel"}');
  f.client.send('{"type":"\\tresponse.append \\n"}');
  f.client.close();
  await f.drain();
  assert.deepEqual(f.starts.map((value) => value.requestId).sort(), [first, second]);
});

test("escaped request types retain the same sequence as their decoded producer value", async (t) => {
  const f = await fixture(t);
  const encoded = [...(" ".repeat(200) + "response.create")]
    .map((char) => "\\u" + char.charCodeAt(0).toString(16).padStart(4, "0"))
    .join("");
  f.client.send(`{"type":"${encoded}"}`);
  f.client.send(JSON.stringify({ type: " ".repeat(256) + "response.create" }));
  f.client.close();
  await f.drain();
  assert.deepEqual(
    f.starts.map((value) => value.requestId),
    [first],
  );
});

test("native drain payloads retain terminal joins without changing bytes or inventing receipts", async (t) => {
  const f = await fixture(t, true, true);
  const frame = (text: string, input = false) => {
    const bytes = new TextEncoder().encode(text);
    const wire = new Uint8Array(bytes.length + (input ? 5 : 1));
    if (input) new DataView(wire.buffer).setUint32(1, 1);
    wire.set(bytes, input ? 5 : 1);
    return wire.buffer;
  };
  const one = frame('{"type":"response.create","input":"private-one"}', true);
  const two = frame('{"type":"response.append","input":"private-two"}', true);
  const receipt = new Uint8Array([2, 0, 0, 0, 1, 0, 0, 0, 55]).buffer;
  const completed = frame(
    '{"type":"response.completed","response":{"id":"one","status":"completed"}}',
  );
  const failed = frame('{"type":"response.failed","response":{"id":"two","status":"failed"}}');
  f.client.send(one);
  f.client.send(two);
  f.upstream.send(receipt);
  f.upstream.send(frame(JSON.stringify({ type: "basalt.request_started", request_id: first })));
  f.upstream.send(completed);
  f.upstream.send(frame(JSON.stringify({ type: "basalt.request_started", request_id: second })));
  f.upstream.send(failed);
  f.client.close();
  await f.drain();
  assert.deepEqual(f.outbound, [one, two]);
  assert.deepEqual(f.delivered, [receipt, completed, failed]);
  assert.deepEqual(f.finishes.map((value) => [value.requestId, value.outcome]).sort(), [
    [first, "complete"],
    [second, "provider_failed"],
  ]);
  assert.doesNotMatch(JSON.stringify([f.starts, f.finishes]), /private-/);
});

test("large ignored scalars and nested content cannot desynchronize the producer's request count", async (t) => {
  const f = await fixture(t);
  f.client.send('{"type":"response.create","input":' + "1".repeat(4096) + "}");
  f.client.send(
    '{"type":"response.create","input":' + "[".repeat(500) + "0" + "]".repeat(500) + "}",
  );
  f.client.close();
  await f.drain();
  assert.deepEqual(
    f.starts.map((value) => value.requestId),
    [first, second],
  );
});

test("terminal observation preserves the upstream retry close code and reason", async (t) => {
  const f = await fixture(t);
  const closed = Promise.withResolvers<Event & { code?: number; reason?: string }>();
  f.client.addEventListener("close", (event) => closed.resolve(event));
  f.upstream.close(1012, "Retry upstream");
  const event = await closed.promise;
  await f.drain();
  assert.equal(event.code, 1012);
  assert.equal(event.reason, "Retry upstream");
});
