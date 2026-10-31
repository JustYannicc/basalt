import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { mobileController } from "../clients/mobile/controller.ts";
import { deviceSocket } from "../clients/cli/device-socket.ts";
import { availableModels, tryModel } from "../clients/connection/models.ts";
import { connectTools } from "../clients/connection/tools.ts";

/** Actual mobile controller against the built Router, hosted grants and deployed app tools. */
export async function verifyNativeMobile({ origin, owner, app, receipt }) {
  let saved;
  const store = {
    read: async () => saved,
    write: async (value) => {
      saved = value;
    },
    remove: async () => {
      saved = undefined;
    },
  };
  const ports = {
    store,
    socket: deviceSocket,
    crypto: {
      randomBytes: () => randomBytes(32),
      sha256: async (bytes) => createHash("sha256").update(bytes).digest(),
    },
    openApproval: async (url) => {
      const userCode = new URL(url).searchParams.get("user_code");
      const approval = await fetch(`${origin}/api/auth/device/decide`, {
        method: "POST",
        headers: {
          ...owner,
          "x-basalt-native-intent": "approved-native-intent",
          "x-basalt-native-name": "Phone controller proof",
          "x-basalt-native-pool": "pool-native-client",
          "x-basalt-native-models": "true",
          "x-basalt-native-tools": "true",
        },
        body: JSON.stringify({ user_code: userCode, accept: true }),
      });
      assert.equal(approval.status, 200);
    },
    closeApproval: () => {},
  };
  const controller = mobileController(ports);
  await controller.initialize();
  await controller.signIn(origin);
  assert.equal(
    controller.getSnapshot().connection?.state,
    "connected",
    JSON.stringify(controller.getSnapshot()),
  );
  assert.ok(saved);
  assert.ok(controller.getSnapshot().connection.display.account.email);
  assert.equal(controller.getSnapshot().connection.display.pool.id, "pool-native-client");
  const restored = mobileController(ports);
  await restored.initialize();
  const signal = new AbortController().signal;
  assert.deepEqual(await restored.run(availableModels, signal), ["synthetic-model"]);
  const updates = [];
  assert.equal(
    await restored.run(
      (source, active) =>
        tryModel(source, "synthetic-model", "Hello", active, (text) => updates.push(text)),
      signal,
    ),
    "Phone reply 🌍",
  );
  assert.deepEqual(updates, ["Phone reply 🌍"]);
  const call = (name, args) =>
    restored.run(async (source, active) => {
      const client = await connectTools(source, active);
      try {
        return await client.call(name, args);
      } finally {
        await client.close();
      }
    }, signal);
  const search = await call("search", { namespace: app.slug, query: "echo", limit: 10 });
  const path = search.items.find((item) => item.path.endsWith(".echo"))?.path;
  assert.ok(path, JSON.stringify(search));
  const result = await call("call", { calls: { path, input: {} } });
  assert.equal(result.status, "completed");
  assert.ok(JSON.stringify(result).includes(receipt));
  const confirm = await call("search", { namespace: app.slug, query: "confirm", limit: 10 });
  const confirmPath = confirm.items.find((item) => item.path.endsWith(".confirm"))?.path;
  assert.ok(confirmPath);
  const pending = await call("call", { calls: { path: confirmPath, input: {} } });
  assert.equal(pending.status, "approval-required");
  const declined = await call("resume", {
    requestId: pending.requestId,
    response: { action: "decline" },
  });
  assert.equal(declined.status, "completed");
  assert.ok(!JSON.stringify(declined).includes(receipt));
  const second = await call("call", { calls: { path: confirmPath, input: {} } });
  assert.equal(second.status, "approval-required");
  const accepted = await call("resume", {
    requestId: second.requestId,
    response: { action: "accept", content: {} },
  });
  assert.equal(accepted.status, "completed");
  assert.ok(JSON.stringify(accepted).includes(receipt));
  await restored.foreground(false);
  await assert.rejects(restored.run(availableModels, signal));
  await restored.foreground(true);
  assert.equal(restored.getSnapshot().connection?.state, "connected");
  await restored.disconnect();
  await assert.rejects(restored.run(availableModels, signal));
  await restored.reconnect();
  await restored.revoke();
  assert.equal(saved, undefined);
  await assert.rejects(controller.run(availableModels, signal));
  assert.equal(controller.getSnapshot().connection?.state, "sign-in-required");
  return {
    controller: true,
    realHostedGrant: true,
    modelStream: true,
    deployedToolReceipt: true,
    declinedAndAcceptedApprovals: true,
    newMcpSessionResumesOriginalCall: true,
    grantRestored: true,
    foregroundRevalidation: true,
    disconnectAndRevokeRefused: true,
    nativeStorageAndUi: "not exercised by this headless proof",
  };
}
