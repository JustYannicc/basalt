import assert from "node:assert/strict";
import { test } from "node:test";
import { once } from "node:events";
import { WebSocket } from "ws";
import { envelopeFixture } from "./native-envelope-fixture.ts";

for (const size of [65_535, 65_536, 65_537, 1_048_577, 16_777_216])
  test(`native public bridge round trips a ${size}-byte context as one WebSocket message`, async () => {
    const f = await envelopeFixture();
    const socket = new WebSocket(f.origin, { perMessageDeflate: false });
    try {
      await once(socket, "open");
      const expected = Buffer.alloc(size, 97);
      const reply = once(socket, "message");
      socket.send(expected, { binary: false });
      const [actual, binary] = await reply;
      assert.deepEqual(actual, expected);
      assert.equal(binary, false);
      assert.deepEqual(f.protocols, ["basalt.tunnel.v2"]);
      assert.equal(f.models.length, 1, "No dispatch replay.");
      assert.equal(f.models[0]?.messages.length, 1, "Chunking preserves one model message.");
    } finally {
      socket.terminate();
      await f.close();
    }
  });

test("native v2 keeps full-context/tool turns beyond one MiB cumulative input", async () => {
  const f = await envelopeFixture();
  const socket = new WebSocket(f.origin, { perMessageDeflate: false });
  try {
    await once(socket, "open");
    for (let index = 0; index < 20; index++) {
      const expected = JSON.stringify({
        type: "response.create",
        input: [{ type: "function_call_output", output: "🙂".repeat(20_000) }],
      });
      const reply = once(socket, "message");
      socket.send(expected);
      const [actual, binary] = await reply;
      assert.equal(actual.toString(), expected);
      assert.equal(binary, false);
    }
    for (const expected of [Buffer.from([0, 255, 128]), Buffer.alloc(0)]) {
      const reply = once(socket, "message");
      socket.send(expected);
      const [actual, binary] = await reply;
      assert.deepEqual(actual, expected);
      assert.equal(binary, true);
    }
    assert.equal(f.models[0]?.messages.length, 22);
    assert.equal(f.models.length, 1);
  } finally {
    socket.terminate();
    await f.close();
  }
});

test("new native clients fall back to a v1 server before dispatch and keep its old limits", async () => {
  const f = await envelopeFixture(true);
  const socket = new WebSocket(f.origin);
  try {
    await once(socket, "open");
    const reply = once(socket, "message");
    socket.send("legacy-compatible");
    assert.equal((await reply)[0].toString(), "legacy-compatible");
    assert.deepEqual(f.protocols, ["basalt.tunnel.v2", "basalt.tunnel.v1"]);
    assert.equal(f.models.length, 1, "The refused v2 handshake must not dispatch.");
    const closed = once(socket, "close");
    socket.send(Buffer.alloc(65_537));
    assert.equal((await closed)[0], 1009);
    assert.equal(f.models[0]?.messages.length, 1);
  } finally {
    socket.terminate();
    await f.close();
  }
});

test("an installed v1 client gets the identical legacy READY on the new server", async () => {
  const f = await envelopeFixture();
  const socket = new WebSocket(f.tunnelUrl, "basalt.tunnel.v1");
  try {
    const [raw] = await once(socket, "message");
    const ready = JSON.parse(raw.toString());
    assert.deepEqual(ready.limits, {
      frameBytes: 32768,
      chunkBytes: 16384,
      windowBytes: 65536,
      requestBytes: 16777216,
      websocketRequestBytes: 1048576,
      operations: 16,
      sessionMilliseconds: 600000,
    });
    assert.equal(ready.type, "ready");
    assert.equal(ready.v, 1);
    assert.equal(socket.protocol, "basalt.tunnel.v1");
    assert.equal(f.models.length, 0);
  } finally {
    socket.terminate();
    await f.close();
  }
});

test("a slow local reader resumes a large message without replay or truncation", async () => {
  const f = await envelopeFixture();
  const socket = new WebSocket(f.origin, { perMessageDeflate: false });
  try {
    await once(socket, "open");
    const model = f.models[0]!;
    const expected = Buffer.alloc(1_048_577, 137);
    const reply = once(socket, "message");
    socket.pause();
    socket.send(expected);
    await model.received.promise;
    socket.resume();
    const [actual, binary] = await reply;
    assert.deepEqual(actual, expected);
    assert.equal(binary, true);
    assert.equal(f.models.length, 1);
    assert.equal(model.messages.length, 1);
  } finally {
    socket.terminate();
    await f.close();
  }
});

test("overflow after dispatch closes the native operation without another inference", async () => {
  const f = await envelopeFixture();
  const socket = new WebSocket(f.origin);
  try {
    await once(socket, "open");
    const closed = once(socket, "close");
    f.models[0]!.dispatchEvent(new MessageEvent("message", { data: new ArrayBuffer(16_777_217) }));
    await closed;
    assert.equal(f.models.length, 1);
    assert.deepEqual(f.protocols, ["basalt.tunnel.v2"]);
    assert.equal(f.models[0]!.closed, true);
  } finally {
    socket.terminate();
    await f.close();
  }
});
