import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";

// The connection's private IPC is a Unix socket here; Windows uses a named pipe.
const skip = process.platform === "win32";
import { privateDirectory, writePrivate } from "../cli/private-files.ts";
import { ipcPath } from "../cli/profile.ts";
import { ConnectionStartingError, ConnectionSupervisor } from "../desktop/supervisor.ts";

/**
 * Another process's connection that answers status but hasn't written its local address yet, as
 * it does between starting its IPC listener and writing runtime.json.
 */
async function startingConnection() {
  const home = await privateDirectory(await mkdtemp(join(tmpdir(), "desktop-attach-")));
  const socket = ipcPath(home);
  await privateDirectory(dirname(socket));
  let statusReads = 0;
  const server = createServer((_request, response) => {
    statusReads++;
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ state: "connected", mode: "device", capabilities: ["models"] }));
  });
  server.listen(socket);
  await once(server, "listening");
  return {
    home,
    statusReads: () => statusReads,
    write: (origin: string) =>
      writePrivate(join(home, "runtime.json"), JSON.stringify({ version: 1, origin })),
    close: async () => {
      server.closeAllConnections();
      server.close();
      await once(server, "close");
      await rm(dirname(socket), { recursive: true, force: true });
      await rm(home, { recursive: true, force: true });
    },
  };
}

/** A pause the test releases by hand, so each address read happens when the test says. */
function heldPause() {
  const waiting: (() => void)[] = [];
  let arrived: (() => void) | undefined;
  return {
    pause: () =>
      new Promise<void>((resolve) => {
        waiting.push(resolve);
        arrived?.();
      }),
    /** Resolves once the supervisor has read no address and is waiting to read again. */
    arrival: () =>
      waiting.length > 0
        ? Promise.resolve()
        : new Promise<void>((resolve) => {
            arrived = resolve;
          }),
    release: () => waiting.shift()?.(),
  };
}

test("attaching to a starting connection waits for its local address", { skip }, async () => {
  const outside = await startingConnection();
  const held = heldPause();
  try {
    const supervisor = new ConnectionSupervisor(outside.home, "unused-entry", "unused-node", {
      pause: held.pause,
    });
    let attached = false;
    const start = supervisor.start().then(() => {
      attached = true;
    });
    await Promise.race([
      held.arrival(),
      start.then(() => assert.fail("Attached before the connection had a local address.")),
    ]);
    assert.equal(attached, false);
    await outside.write("http://127.0.0.1:41234");
    held.release();
    await start;
    assert.equal(await supervisor.origin(), "http://127.0.0.1:41234");
    assert.equal(outside.statusReads(), 1, "Attaching never spawns or asks again.");
  } finally {
    await outside.close();
  }
});

test(
  "an attached connection that never gets an address is refused after the bound",
  { skip },
  async () => {
    const outside = await startingConnection();
    try {
      const supervisor = new ConnectionSupervisor(outside.home, "unused-entry", "unused-node", {
        attachWaitMs: 0,
      });
      await assert.rejects(supervisor.start(), ConnectionStartingError);
    } finally {
      await outside.close();
    }
  },
);

test("an invalid local address is refused at once, not waited for", { skip }, async () => {
  const outside = await startingConnection();
  const held = heldPause();
  try {
    await outside.write("https://example.com/");
    const supervisor = new ConnectionSupervisor(outside.home, "unused-entry", "unused-node", {
      pause: held.pause,
    });
    await assert.rejects(supervisor.start(), /address is invalid/u);
  } finally {
    await outside.close();
  }
});

test("stopping while attaching ends the wait", { skip }, async () => {
  const outside = await startingConnection();
  const held = heldPause();
  try {
    const supervisor = new ConnectionSupervisor(outside.home, "unused-entry", "unused-node", {
      pause: held.pause,
    });
    const start = supervisor.start();
    await held.arrival();
    await supervisor.stop();
    held.release();
    await assert.rejects(start, /Stopped while attaching/u);
  } finally {
    await outside.close();
  }
});
