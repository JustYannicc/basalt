import assert from "node:assert/strict";
import { createServer, type Server } from "node:net";
import { test } from "node:test";
import { Effect } from "effect";
import {
  ephemeralPorts,
  freePort,
  holdPort,
  pickablePorts,
} from "../../.upstream/e2e/support/ports.ts";

const listen = (port: number) =>
  new Promise<Server>((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => resolve(server));
  });
const portOf = (server: Server) => {
  const address = server.address();
  assert.ok(address !== null && typeof address !== "string");
  return address.port;
};
const close = (servers: readonly Server[]) =>
  Promise.all(
    servers.map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
  );

test("the ephemeral range read from the OS is where the OS puts port-0 binds", async () => {
  const range = await Effect.runPromise(ephemeralPorts);
  const servers = await Promise.all(Array.from({ length: 40 }, () => listen(0)));
  try {
    for (const port of servers.map(portOf)) {
      assert.ok(
        port >= range.first && port <= range.last,
        `${port} outside ${range.first}-${range.last}`,
      );
    }
  } finally {
    await close(servers);
  }
});

test("a picked port is never one the OS hands out by itself, nor one picked before", async () => {
  const range = await Effect.runPromise(ephemeralPorts);
  const picked = new Set<number>();
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const port = await Effect.runPromise(freePort);
    assert.ok(
      port >= 1024 && (port < range.first || port > range.last),
      `${port} inside ${range.first}-${range.last}`,
    );
    assert.ok(!picked.has(port), `${port} picked twice`);
    picked.add(port);
  }
});

test("ports are picked below the range, and above it when the range starts low", () => {
  assert.deepEqual(pickablePorts({ first: 32768, last: 60999 }), [
    { from: 16384, to: 32768 },
    { from: 61000, to: 65536 },
  ]);
  assert.deepEqual(pickablePorts({ first: 49152, last: 65535 }), [{ from: 32768, to: 49152 }]);
  assert.deepEqual(pickablePorts({ first: 1024, last: 60999 }), [{ from: 61000, to: 65536 }]);
  assert.deepEqual(pickablePorts({ first: 1024, last: 65535 }), []);
});

test("a restart gets its picked port back while other servers bind port 0 in between", async () => {
  const port = await Effect.runPromise(freePort);
  await close([await listen(port)]);
  // A restarted product starts its own collectors on port 0 before it listens again.
  const others = await Promise.all(Array.from({ length: 100 }, () => listen(0)));
  try {
    assert.ok(!others.map(portOf).includes(port));
    assert.equal(await Effect.runPromise(Effect.scoped(holdPort(port))), port);
  } finally {
    await close(others);
  }
});
