import assert from "node:assert/strict";
import { test } from "node:test";
import { tunnelLimits, type TunnelOpen } from "../../clients/contracts/tunnel.ts";
import type { TunnelSocket } from "./platform.ts";
import { serveTunnel } from "./session.ts";
import { createTunnelTimingSampler } from "./timing.ts";

class Peer extends EventTarget implements TunnelSocket {
  binaryType: BinaryType = "arraybuffer";
  accept() {}
  send() {}
  close() {
    this.dispatchEvent(new Event("close"));
  }
  frame(value: unknown) {
    this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(value) }));
  }
}

const open = (id: number): TunnelOpen => ({
  v: 1,
  type: "open",
  id,
  operation: { service: "tools", transport: "http", method: "POST", path: "/mcp" },
  headers: { "content-type": "application/json", "mcp-session-id": "private-session" },
});

test("milestones locate held headers while a sibling request completes on the same tunnel", async () => {
  let clock = 1000;
  const events: Record<string, unknown>[] = [];
  const timing = createTunnelTimingSampler(
    () => clock,
    (event) => events.push(event),
  )()!;
  const socket = new Peer();
  const lease = new Peer();
  const work: Promise<unknown>[] = [];
  const { promise: held, resolve: release } = Promise.withResolvers<Response>();
  let calls = 0;
  serveTunnel(
    socket,
    lease,
    new Request("https://private-host.example/native/v1/tunnel", {
      headers: { authorization: "Bearer private-credential" },
    }),
    {
      POOL_APP_SIGNING_KEY: "ab".repeat(32),
      TOOLS_SERVICE: {
        fetch: async () => (++calls === 1 ? held : new Response(null, { status: 202 })),
      },
      POOL_SERVICE: { fetch: async () => assert.fail("No model dispatch expected") },
    },
    {
      id: "native:private-grant",
      userId: "private-user",
      clientId: "private-client",
      expiresAt: clock + tunnelLimits.sessionMilliseconds + Date.now(),
      policy: {
        kind: "native",
        computer: "private-computer",
        pool: "private-pool",
        models: false,
        toolsOrganization: "private-organization",
      },
    },
    (promise) => work.push(promise),
    timing,
  );
  try {
    socket.frame(open(1));
    clock += 54_000;
    socket.frame({ v: 1, type: "end", id: 1 });
    socket.frame(open(2));
    socket.frame({ v: 1, type: "end", id: 2 });
    await work[2];
    assert.deepEqual(
      events.filter((event) => event.id === 1).map((event) => event.stage),
      ["open", "dispatch", "upload-end"],
    );
    assert.equal(
      events.find((event) => event.id === 1 && event.stage === "upload-end")?.operationMs,
      54_000,
    );
    assert.ok(events.some((event) => event.id === 2 && event.stage === "response-end"));
    assert.equal(events.filter((event) => event.id === 1 && event.stage === "headers").length, 0);
    release(new Response(null, { status: 202 }));
    await work[1];
    assert.equal(
      events.find((event) => event.id === 1 && event.stage === "headers")?.operationMs,
      54_000,
    );
    assert.ok(events.some((event) => event.stage === "ready"));
    const serialized = JSON.stringify(events);
    assert.doesNotMatch(serialized, /private-|Bearer|authorization|\/mcp|example/);
    assert.equal(new Set(events.map((event) => event.tunnel)).size, 1);
  } finally {
    release(new Response(null));
    socket.close();
    await Promise.all(work);
  }
});

test("sampling bounds sessions and lifetime operations and reopens after one minute", () => {
  let clock = 1000;
  const events: unknown[] = [];
  const sample = createTunnelTimingSampler(
    () => clock,
    (event) => events.push(event),
  );
  for (let session = 0; session < 4; session++) {
    const timing = sample()!;
    for (let id = 1; id <= 100; id++) {
      const operation = timing.operation(open(id));
      for (let duplicate = 0; duplicate < 10; duplicate++) operation?.("dispatch");
    }
  }
  assert.equal(events.length, 32);
  assert.equal(sample(), undefined);
  clock += 59_999;
  assert.equal(sample(), undefined);
  clock++;
  assert.ok(sample());
});

test("a failed diagnostic sink cannot block an operation", () => {
  const timing = createTunnelTimingSampler(Date.now, () => {
    throw new Error("sink unavailable");
  })()!;
  assert.doesNotThrow(() => {
    timing.mark("access");
    timing.operation(open(1))?.("dispatch");
  });
});

test("a failed READY send records closure without claiming readiness", async () => {
  class BrokenPeer extends Peer {
    send() {
      throw new Error("synthetic socket failure");
    }
  }
  const stages: string[] = [];
  const timing = createTunnelTimingSampler(Date.now, (event) => stages.push(event.stage))()!;
  const work: Promise<unknown>[] = [];
  serveTunnel(
    new BrokenPeer(),
    new Peer(),
    new Request("https://fixture.example/native/v1/tunnel"),
    {
      POOL_APP_SIGNING_KEY: "ab".repeat(32),
      TOOLS_SERVICE: { fetch: async () => assert.fail("No dispatch expected") },
      POOL_SERVICE: { fetch: async () => assert.fail("No dispatch expected") },
    },
    {
      id: "native:fixture",
      userId: "fixture",
      clientId: "fixture",
      expiresAt: Date.now() + 60_000,
      policy: { kind: "native", computer: "fixture", pool: "fixture", models: true },
    },
    (promise) => work.push(promise),
    timing,
  );
  await Promise.all(work);
  assert.deepEqual(stages, ["closed"]);
});
