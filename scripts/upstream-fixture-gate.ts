import assert from "node:assert/strict";
import { once } from "node:events";
import { createConnection, createServer, type Socket } from "node:net";
import type { TestContext } from "node:test";

/** Filesystem notifications can disappear under parallel fixture churn. */
export async function fixtureGate(t: TestContext) {
  const sockets = new Set<Socket>();
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });
  t.after(() => {
    for (const socket of sockets) socket.destroy();
    server.close();
  });
  const listening = once(server, "listening");
  server.listen(0, "127.0.0.1");
  await listening;
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const connected = new Promise<Socket>((resolve) => server.once("connection", resolve));
  return {
    port: String(address.port),
    async release() {
      const socket = await connected;
      socket.end("!");
    },
  };
}

export async function waitForFixtureRelease(port: string) {
  const socket = createConnection({ host: "127.0.0.1", port: Number(port) });
  try {
    for await (const data of socket) {
      assert.equal(String(data), "!", "Unexpected fixture release");
      return;
    }
    throw new Error("Fixture gate closed before release");
  } finally {
    socket.destroy();
  }
}
