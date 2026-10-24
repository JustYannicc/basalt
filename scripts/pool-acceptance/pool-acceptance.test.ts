import assert from "node:assert/strict";
import test from "node:test";
import { runPoolAcceptance } from "../pool-acceptance.ts";
import { PoolAcceptanceClient } from "./client.ts";
import { observeRestart } from "./restart-observation.ts";

const model = "fixture-model";

async function runFixture(options: { accounts?: string[]; unexpectedUsage?: boolean } = {}) {
  let now = 1_000;
  let modelReads = 0;
  let streamReads = 0;
  const sessionCredential = new Map<string, string>();
  const sessionTurns = new Map<string, number>();
  const usageReads = new Map<string, number>();
  const logs: string[] = [];

  const client = new PoolAcceptanceClient({
    origin: "https://fixture.invalid",
    now: () => now,
    delay: async (ms) => { now += ms; },
    usagePollWindowMs: 5_000,
    usagePollIntervalMs: 500,
    fetch: async (input, init) => {
      const url = new URL(input.toString());
      if (url.pathname === "/pool/v1/pool") {
        assert.equal(new Headers(init?.headers).get("authorization"), "Bearer pool-token-fixture");
        assert.equal(new Headers(init?.headers).get("x-signalbox-caller"), "acceptance");
        return Response.json({ isOwner: true, accounts: (options.accounts ?? ["subscription-a", "subscription-b"]).map(id => ({ id })) });
      }
      if (url.pathname === "/v1/models") {
        modelReads += 1;
        if (modelReads === 4) return new Response("rolling restart", { status: 503 });
        if (modelReads >= 3) now += 400;
        const boot = modelReads >= 5 ? "new-boot" : "old-boot";
        return Response.json({ data: [{ id: model }] }, {
          headers: { "X-Signalbox-Pool-Boot": boot },
        });
      }
      if (url.pathname === "/v1/chat/completions") {
        streamReads += 1;
        const headers = new Headers(init?.headers);
        assert.equal(headers.get("authorization"), "Bearer acceptance-fixture");
        assert.equal(headers.get("accept"), "text/event-stream");
        const sessionId = headers.get("x-session-id");
        assert.ok(sessionId);
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        assert.equal(body.model, model);
        assert.equal(body.prompt_cache_key, undefined);
        assert.deepEqual([...headers.keys()].sort(), ["accept", "authorization", "content-type", "x-session-id"]);
        assert.equal(body.stream, true);
        const turns = (sessionTurns.get(sessionId) ?? 0) + 1;
        sessionTurns.set(sessionId, turns);
        if (!sessionCredential.has(sessionId)) {
          sessionCredential.set(sessionId, sessionCredential.size % 2 === 0 ? "subscription-a" : "subscription-b");
        }
        const wireBoot = streamReads === 8 ? "new-boot" : "old-boot";
        const event = `data: ${JSON.stringify({ choices: [{ delta: { content: "OK" } }] })}\n\ndata: [DONE]\n\n`;
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode(event));
            controller.close();
          },
        });
        return new Response(stream, {
          headers: {
            "content-type": "text/event-stream; charset=utf-8",
            "X-Signalbox-Pool-Boot": wireBoot,
          },
        });
      }
      if (url.pathname === "/pool/v1/usage") {
        const wireSessionId = url.searchParams.get("session");
        assert.ok(wireSessionId && sessionTurns.has(wireSessionId));
        assert.equal(url.searchParams.has("session_id"), false);
        assert.equal(url.searchParams.get("status"), "success");
        assert.equal(url.searchParams.get("limit"), "20");
        assert.equal(new Headers(init?.headers).get("authorization"), "Bearer pool-token-fixture");
        assert.equal(new Headers(init?.headers).get("x-signalbox-caller"), "acceptance");
        const reads = (usageReads.get(wireSessionId) ?? 0) + 1;
        usageReads.set(wireSessionId, reads);
        if (reads === 1) return Response.json({ records: [] });
        const expected = sessionTurns.get(wireSessionId) ?? 0;
        const account = sessionCredential.get(wireSessionId);
        assert.ok(account);
        const records = Array.from({ length: expected }, (_, index) => ({
          id: `${wireSessionId}-${index}`,
          account: options.unexpectedUsage ? `unexpected-${account}` : account,
          status: "success",
          at: "2026-10-23T12:00:00Z",
        }));
        return Response.json({ records });
      }
      throw new Error(`unexpected fixture URL ${url.pathname}`);
    },
  });

  await runPoolAcceptance({
    apiKey: "acceptance-fixture",
    poolAccess: { token: "pool-token-fixture", owner: "acceptance" },
    mode: "full",
    model,
  }, {
    client,
    hooks: {
      waitForIdle: async () => {
        assert.equal(options.accounts?.length ?? 2, 2);
        assert.equal(streamReads, 0);
        return 3_600;
      },
      log: (message) => logs.push(message),
      restart: (input) => observeRestart({
        ...input,
        options: {
          ...input.options,
          now: () => now,
          delay: async (ms) => { now += ms; },
          windowMs: 10_000,
          pollDelayMs: 2_000,
          probeTimeoutMs: 1_000,
        },
      }),
    },
  });

  return { modelReads, streamReads, usageReads, sessionTurns, logs };
}

test("public runner uses wire session IDs, scoped records, and a changed boot with local fetch fixtures", async () => {
  const { modelReads, streamReads, usageReads, sessionTurns, logs } = await runFixture();
  assert.equal(modelReads, 5);
  assert.equal(streamReads, 8);
  assert.equal(usageReads.size, 5);
  assert.ok([...sessionTurns.values()].includes(2));
  assert.ok(logs.includes("usage_records status=200 matched=7 exact_session_filters=5"));
  assert.ok(logs.includes("affinity status=passed repeated_conversations=2 new_conversations=2 subscriptions=2"));
  assert.ok(logs.some((line) => line.includes("deployment_assumption=otherwise_quiet")));
  assert.ok(logs.includes("acceptance status=passed mode=full"));
});


test("full acceptance rejects extra test-pool accounts before waiting or model turns", async () => {
  await assert.rejects(runFixture({ accounts: ["subscription-a", "subscription-b", "subscription-c"] }), /exactly two distinct accounts/);
});

test("full acceptance rejects two usage accounts that differ from the pool accounts", async () => {
  await assert.rejects(runFixture({ unexpectedUsage: true }), /outside the dedicated test pool/);
});
