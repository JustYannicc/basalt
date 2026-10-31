import assert from "node:assert/strict";
import { test } from "node:test";
import { createHash, randomBytes } from "node:crypto";
import { Schema } from "effect";
import { mobileController } from "../mobile/controller.ts";
import { deviceSocket } from "../cli/device-socket.ts";
import { availableModels, tryModel } from "../connection/models.ts";
import { connectTools } from "../connection/tools.ts";
import { serverEvents } from "../connection/request.ts";
import { nativeFixture } from "./native-fixture.ts";

test("mobile signs in, restores its grant, streams a model and resumes approved tools without replay", async () => {
  let writes = 0,
    calls = 0;
  let fault = false;
  const json = (value: unknown) => ({
    status: 200,
    headers: { "content-type": "application/json", "mcp-session-id": "phone-session" },
    chunks: [Buffer.from(JSON.stringify(value))],
  });
  const remote = await nativeFixture(({ operation, body, headers }) => {
    if (operation.service === "models") {
      if (operation.path === "/v1/models") return json({ data: [{ id: "fixture/model" }] });
      assert.equal(operation.path, "/v1/chat/completions");
      assert.equal(JSON.parse(body).model, "fixture/model");
      const raw = Buffer.from(
        `data: ${JSON.stringify({ choices: [{ delta: { content: "Hello 🌍" } }] })}\r\n\r\ndata: [DONE]\r\n\r\n`,
      );
      const split = raw.indexOf(Buffer.from("🌍")) + 2;
      return {
        status: 200,
        headers: { "content-type": "text/event-stream" },
        chunks: [raw.subarray(0, split), raw.subarray(split)],
      };
    }
    assert.equal(operation.path, "/mcp");
    const rpc = JSON.parse(body);
    if (rpc.method === "initialize")
      return json({
        jsonrpc: "2.0",
        id: rpc.id,
        result: {
          protocolVersion: "2025-03-26",
          capabilities: { tools: {} },
          serverInfo: { name: "independent-phone-peer", version: "1" },
        },
      });
    assert.equal(headers["mcp-session-id"], "phone-session");
    if (rpc.method === "notifications/initialized") return { status: 202 };
    assert.equal(rpc.method, "tools/call");
    calls++;
    if (fault) {
      writes++;
      return { status: 503 };
    }
    const structuredContent =
      rpc.params.name === "search"
        ? {
            items: [
              { path: "tools.fixture.create", description: "Create a fixture entry", input: "{}" },
            ],
            namespaces: [],
            remaining: 0,
            next: null,
          }
        : rpc.params.name === "call"
          ? {
              status: "approval-required",
              requestId: "approval-fixture",
              expiresAt: Date.now() + 60_000,
              elicitation: {
                mode: "form",
                message: "Create a fixture entry?",
                requestedSchema: { type: "object", properties: {} },
              },
            }
          : (() => {
              assert.equal(rpc.params.name, "resume");
              assert.equal(rpc.params.arguments.requestId, "approval-fixture");
              if (rpc.params.arguments.response.action === "accept") writes++;
              return {
                status: "completed",
                execution: { ok: true, value: { writes } },
                unavailableApps: [],
              };
            })();
    return json({ jsonrpc: "2.0", id: rpc.id, result: { content: [], structuredContent } });
  });
  let saved: string | undefined;
  let browserOpened = 0;
  let browserClosed = 0;
  const make = () =>
    mobileController({
      store: {
        read: async () => saved,
        write: async (value) => {
          saved = value;
        },
        remove: async () => {
          saved = undefined;
        },
      },
      socket: deviceSocket,
      crypto: {
        randomBytes: () => randomBytes(32),
        sha256: async (bytes) => createHash("sha256").update(bytes).digest(),
      },
      openApproval: async (url) => {
        assert.equal(new URL(url).origin, remote.origin);
        browserOpened++;
        remote.approve();
      },
      closeApproval: () => {
        browserClosed++;
      },
    });
  try {
    const first = make();
    await first.initialize();
    assert.equal(first.getSnapshot().phase, "signed-out");
    await first.signIn(remote.origin);
    assert.equal(browserOpened, 1);
    assert.equal(browserClosed, 1);
    assert.equal(first.getSnapshot().connection?.state, "connected");
    assert.ok(saved);
    assert.ok(!JSON.stringify(first.getSnapshot()).includes("synthetic-access"));
    const restarted = make();
    await restarted.initialize();
    const signal = new AbortController().signal;
    assert.deepEqual(await restarted.run(availableModels, signal), ["fixture/model"]);
    const updates: string[] = [];
    const reply = await restarted.run(
      (source, active) =>
        tryModel(source, "fixture/model", "Hello", active, (text) => updates.push(text)),
      signal,
    );
    assert.equal(reply, "Hello 🌍");
    assert.deepEqual(updates, [reply]);
    const tools = await restarted.run(connectTools, signal);
    try {
      assert.ok(await tools.call("search", { query: "fixture" }));
      const pending = await tools.call("call", {
        calls: { path: "tools.fixture.create", input: {} },
      });
      assert.equal(
        Schema.decodeUnknownSync(Schema.Struct({ status: Schema.String }))(pending).status,
        "approval-required",
      );
      assert.equal(writes, 0);
      await tools.call("resume", {
        requestId: "approval-fixture",
        response: { action: "decline" },
      });
      assert.equal(writes, 0);
      await tools.call("call", { calls: { path: "tools.fixture.create", input: {} } });
      await tools.call("resume", {
        requestId: "approval-fixture",
        response: { action: "accept", content: {} },
      });
      assert.equal(writes, 1);
      const before = calls;
      fault = true;
      await assert.rejects(
        tools.call("call", { calls: { path: "tools.fixture.create", input: {} } }),
      );
      assert.equal(calls, before + 1);
      assert.equal(writes, 2, "An ambiguous write is never replayed.");
    } finally {
      await tools.close();
    }
    const held = remote.holdAccess();
    const pendingRead = restarted.run(availableModels, signal);
    await held.arrived;
    await restarted.foreground(false);
    await assert.rejects(pendingRead);
    held.release();
    await restarted.foreground(true);
    assert.equal(restarted.getSnapshot().connection?.state, "connected");
    await restarted.disconnect();
    await assert.rejects(restarted.run(availableModels, signal));
    await restarted.reconnect();
    await restarted.revoke();
    assert.equal(saved, undefined);
    await assert.rejects(first.run(availableModels, signal));
    assert.equal(first.getSnapshot().connection?.state, "sign-in-required");
  } finally {
    await remote.close();
  }
});

test("a truncated model event is refused instead of reported as complete", async () => {
  async function* chunks() {
    yield new TextEncoder().encode('data: {"partial": true}\n');
  }
  await assert.rejects(async () => {
    for await (const _event of serverEvents(chunks())) {
    }
  }, /mid-event/u);
});

test("a secure-storage failure stays recoverable and sign-out confirms deletion", async () => {
  let unavailable = true,
    removes = 0;
  const controller = mobileController({
    store: {
      read: async () => {
        if (unavailable) throw new Error("Locked");
        return undefined;
      },
      write: async () => {
        throw new Error("Unavailable");
      },
      remove: async () => {
        removes++;
        if (unavailable) throw new Error("Locked");
      },
    },
    socket: () => {
      throw new Error("No socket expected");
    },
    crypto: { randomBytes: () => randomBytes(32), sha256: async () => new Uint8Array(32) },
    openApproval: async () => {},
    closeApproval: () => {},
  });
  await controller.initialize();
  assert.equal(controller.getSnapshot().phase, "storage-error");
  await controller.signOut();
  assert.equal(controller.getSnapshot().phase, "storage-error");
  unavailable = false;
  await controller.signOut();
  assert.equal(controller.getSnapshot().phase, "signed-out");
  assert.equal(removes, 2);
});
