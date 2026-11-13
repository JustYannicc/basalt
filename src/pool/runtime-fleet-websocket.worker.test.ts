import assert from "node:assert/strict";
import { test } from "node:test";
import { Schema } from "effect";
import { ErrorEvent, WebSocket, WebSocketPair } from "miniflare";
import { fleetWorkerFixture } from "../../scripts/pool-tests/runtime-fleet-worker.ts";
import { deferred } from "../../scripts/pool-tests/runtime-handoff-fixture.ts";
import { installWorkerSockets, upgraded } from "../../scripts/pool-tests/native-sockets.ts";
import { RuntimeFleetState } from "./runtime-fleet/state.ts";

async function activeFleet(advance: () => void) {
  const f = await fleetWorkerFixture();
  const requests: Promise<Response>[] = [],
    bodies: ReadableStreamDefaultController<Uint8Array>[] = [];
  const arrived = deferred(),
    release = deferred();
  let count = 0,
    closing = false;
  f.onModel(async () => {
    if (++count === 4) arrived.resolve();
    await release.promise;
    if (closing) return new Response("fixture cleanup");
    return new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          bodies.push(controller);
        },
      }),
    );
  });
  const cleanup = async () => {
    closing = true;
    release.resolve();
    for (const body of bodies)
      try {
        body.close();
      } catch {
        /* An aborted stream has already closed. */
      }
    await Promise.allSettled(
      requests.map(async (request) => {
        await (await request).body?.cancel();
      }),
    );
    await f.cleanup();
  };
  try {
    await f.bootstrap();
    const enabled = Schema.decodeUnknownSync(Schema.Struct({ digest: Schema.String }))(
      await f.send("fleet-configure", { operationId: "enable-1", configuration: f.configuration }),
    );
    for (let index = 0; index < 4; index++)
      requests.push(f.model(new Request(`https://pool.invalid/v1/models?id=pressure-${index}`)));
    await arrived.promise;
    const ready = f.resourcesWhen(
      (rows) => rows.length === 2 && rows.every((row) => row.phase === "ready"),
    );
    advance();
    await f.upkeep();
    await ready;
    const permission = Schema.decodeUnknownSync(Schema.Struct({ digest: Schema.String }))(
      await f.send("fleet-configure", {
        operationId: "enable-2",
        configuration: {
          ...f.configuration,
          revision: 2,
          previousDigest: enabled.digest,
          targetActive: 100,
        },
      }),
    );
    return { ...f, permission, cleanup };
  } catch (error) {
    await cleanup();
    throw error;
  }
}

function nextMessage(socket: WebSocket) {
  const event = deferred<string>();
  socket.addEventListener("message", (message) => event.resolve(String(message.data)), {
    once: true,
  });
  return event.promise;
}

for (const failure of ["upstream", "client", "send"] as const) {
  test(
    `an upgraded ${failure} failure preserves the runtime fault boundary across every relay`,
    { timeout: 20_000 },
    async (context) => {
      let now = Date.now();
      context.mock.method(Date, "now", () => now);
      const restore = installWorkerSockets();
      const f = await activeFleet(() => {
        now += 101;
      }).catch((error: unknown) => {
        restore();
        throw error;
      });
      const sockets: WebSocket[] = [];
      context.after(async () => {
        for (const socket of sockets)
          try {
            socket.close();
          } catch {}
        await f.cleanup();
        restore();
      });
      let upstream: WebSocket | undefined,
        runtime: string | undefined,
        dispatches = 0;
      f.onModel(async (instance) => {
        runtime = instance.target.instanceId;
        dispatches++;
        const pair = new WebSocketPair();
        pair[1].accept();
        upstream = pair[0];
        sockets.push(...Object.values(pair));
        const init = { status: 101, webSocket: pair[0] };
        return new Response(null, init);
      });
      const response = await f.model(
        new Request("https://pool.invalid/v1/responses", { headers: { Upgrade: "websocket" } }),
      );
      assert.equal(response.status, 101);
      const client = upgraded(response);
      sockets.push(client);
      if (failure === "upstream") upstream!.dispatchEvent(new ErrorEvent("error"));
      else if (failure === "client") client.close(1011, "Client transport closed");
      else {
        context.mock.method(upstream!, "send", () => {
          throw new Error("Synthetic upstream send failure");
        });
        client.send("response request frame");
      }
      const rows = await f.resourcesWhen(
        (values) => values.find((row) => row.target.instanceId === runtime)?.active === 0,
      );
      assert.equal(
        rows.find((row) => row.target.instanceId === runtime)?.phase,
        failure === "client" ? "ready" : "quarantined",
      );
      assert.equal(dispatches, 1);
    },
  );
}

test(
  "a native upgraded stream survives fleet replacement and drains only after its protocol terminal",
  { timeout: 20_000 },
  async (context) => {
    let now = Date.now();
    context.mock.method(Date, "now", () => now);
    const restore = installWorkerSockets();
    const f = await activeFleet(() => {
      now += 101;
    }).catch((error: unknown) => {
      restore();
      throw error;
    });
    let upstream: WebSocket | undefined,
      client: WebSocket | undefined,
      dispatches = 0;
    context.after(async () => {
      try {
        client?.close();
        upstream?.close();
      } catch {
        /* Close every live socket before draining background work. */
      }
      await f.cleanup();
      restore();
    });
    f.onModel(async (_instance, request) => {
      assert.equal(request.headers.get("Upgrade"), "websocket");
      dispatches++;
      const pair = new WebSocketPair();
      upstream = pair[1];
      upstream.accept();
      upstream.addEventListener("message", (message) => upstream!.send(`echo:${message.data}`));
      const init = { status: 101, webSocket: pair[0] };
      return new Response(null, init);
    });
    const response = await f.model(
      new Request("https://pool.invalid/v1/responses", { headers: { Upgrade: "websocket" } }),
    );
    assert.equal(response.status, 101);
    client = upgraded(response);
    let message = nextMessage(client);
    client.send("before");
    assert.equal(await message, "echo:before");
    const state = new RuntimeFleetState(f.old.storage, 4);
    const previous = (await state.inspect()).find((row) => row.active === 1)!.identity!;
    const runtime = f.instances.get(previous.instanceId)!;
    await f.send("fleet-configure", {
      operationId: "enable-green",
      configuration: {
        ...f.configuration,
        revision: 3,
        previousDigest: f.permission.digest,
        active: "green",
        targetActive: 100,
      },
    });
    await f.send("fleet-replace", { operationId: "replace-upgrade", identity: previous });
    await f.upkeep();
    assert.equal(
      (await state.inspect()).find((row) => row.target.instanceId === previous.instanceId)!.phase,
      "draining",
    );
    assert.equal(runtime.fixture.calls.destroy, 0);
    const endpointActivity = await runtime.fixture.storage.get<{ phase: string; active: number }>(
      `runtime-activity-v1:${JSON.stringify([previous.slotId, previous.bootId])}`,
    );
    assert.equal(endpointActivity?.phase, "draining");
    assert.equal(endpointActivity?.active, 1);
    f.reconstruct();
    await f.upkeep();
    assert.equal(runtime.fixture.calls.destroy, 0);
    message = nextMessage(client);
    client.send("during");
    assert.equal(await message, "echo:during");
    message = nextMessage(client);
    upstream!.send("response.completed");
    assert.equal(await message, "response.completed");
    const drained = f.resourcesWhen(
      (rows) => rows.find((row) => row.target.instanceId === previous.instanceId)?.active === 0,
    );
    upstream!.close(1000, "Protocol terminal");
    await drained;
    await runtime.fixture.settle();
    await f.upkeep();
    assert.equal(runtime.fixture.calls.destroy, 1);
    assert.equal(dispatches, 1);
    assert.equal(f.old.calls.destroy, 0);
  },
);

test(
  "canonical membership revocation reaches every serving cell and closes its upgraded streams",
  { timeout: 20_000 },
  async (context) => {
    let now = Date.now();
    context.mock.method(Date, "now", () => now);
    const restore = installWorkerSockets();
    const f = await activeFleet(() => {
      now += 101;
    }).catch((error: unknown) => {
      restore();
      throw error;
    });
    const clients: WebSocket[] = [],
      servers: WebSocket[] = [];
    context.after(async () => {
      for (const socket of [...clients, ...servers])
        try {
          socket.close();
        } catch {
          /* Revocation may already have closed it. */
        }
      await f.cleanup();
      restore();
    });
    let dispatches = 0;
    f.onModel(async () => {
      dispatches++;
      const pair = new WebSocketPair();
      pair[1].accept();
      servers.push(pair[1]);
      const init = { status: 101, webSocket: pair[0] };
      return new Response(null, init);
    });
    for (let index = 0; index < 2; index++) {
      const response = await f.model(
        new Request("https://pool.invalid/v1/responses", { headers: { Upgrade: "websocket" } }),
      );
      assert.equal(response.status, 101);
      clients.push(upgraded(response));
    }
    const state = new RuntimeFleetState(f.old.storage, 4);
    assert.ok((await state.inspect()).every((row) => row.active === 1));
    const closed = clients.map((client) => {
      const event = deferred();
      client.addEventListener("close", () => event.resolve(), { once: true });
      return event.promise;
    });
    assert.equal((await f.reserve()).status, 204);
    await Promise.all(closed);
    await f.resourcesWhen((rows) => rows.every((row) => row.active === 0));
    assert.equal(
      (
        await f.model(
          new Request("https://pool.invalid/v1/responses", { headers: { Upgrade: "websocket" } }),
        )
      ).status,
      503,
    );
    for (const runtime of f.instances.values()) {
      assert.ok(
        runtime.fixture.calls.install.some(
          (policy) => policy.pool === f.claims.pool && policy.revision === 2 && policy.dirty,
        ),
      );
      assert.equal(runtime.fixture.calls.start, 1);
    }
    assert.equal(dispatches, 2);
    assert.equal(f.old.calls.destroy, 0);
  },
);
