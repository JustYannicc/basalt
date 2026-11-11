import assert from "node:assert/strict";
import { test } from "node:test";
import { createHash, randomBytes } from "node:crypto";
import { mobileController } from "../mobile/controller.ts";
import { deviceSocket } from "../cli/device-socket.ts";
import { availableModels } from "../connection/models.ts";
import { nativeFixture } from "./native-fixture.ts";

test("a phone handshake without an HTTP status revalidates and exposes authoritative refusal", async () => {
  const remote = await nativeFixture(() => ({
    status: 200,
    chunks: [Buffer.from(JSON.stringify({ data: [{ id: "fixture/model" }] }))],
  }));
  let saved: string | undefined;
  const controller = mobileController({
    store: {
      read: async () => saved,
      write: async (value) => {
        saved = value;
      },
      remove: async () => {
        saved = undefined;
      },
    },
    socket: (url, token) => {
      const socket = deviceSocket(url, token);
      return {
        ...socket,
        listen: (receive) =>
          socket.listen((event) => receive(event.type === "error" ? { type: "error" } : event)),
      };
    },
    crypto: {
      randomBytes: () => randomBytes(32),
      sha256: async (bytes) => createHash("sha256").update(bytes).digest(),
    },
    openApproval: async () => remote.approve(),
    closeApproval: () => {},
  });
  try {
    await controller.initialize();
    await controller.signIn(remote.origin);
    const signal = new AbortController().signal;
    assert.deepEqual(await controller.run(availableModels, signal), ["fixture/model"]);
    const before = remote.counts();
    remote.denyAccess(true);
    remote.refuseNextUpgrade();
    await assert.rejects(controller.run(availableModels, signal));
    assert.equal(remote.counts().accessReads, before.accessReads + 1);
    assert.equal(remote.counts().modelSends, before.modelSends);
    assert.equal(controller.getSnapshot().connection?.state, "sign-in-required");
    await assert.rejects(controller.run(availableModels, signal));
    assert.equal(remote.counts().accessReads, before.accessReads + 1);
    remote.denyAccess(false);
    await controller.reconnect();
    assert.deepEqual(await controller.run(availableModels, signal), ["fixture/model"]);
  } finally {
    await controller.signOut();
    await remote.close();
  }
});
