import assert from "node:assert/strict";
import { test } from "node:test";
import { forwardModelCall } from "./model-replay.ts";
import { TunnelOperation } from "./tunnel/operation.ts";
import { tunnelLimits, type TunnelServerFrame } from "../clients/contracts/tunnel.ts";
import {
  openRouterAttempt,
  routerAttemptHeader,
  signRouterAttempt,
} from "./pool/router-attempt.ts";
import {
  routerResume,
  routerResumeHeader,
  routerResumePath,
  signResumeStamp,
} from "./pool/router-resume.ts";
import {
  encodeResumeTarget,
  streamResumeFromHeader,
  streamResumeHeader,
  streamResumeVersion,
} from "./pool/stream-resume.ts";

const signingKey = "cd".repeat(32);
const noWait = async () => {};
const target = encodeResumeTarget({ kind: "primary" });
const encoder = new TextEncoder();

// The two stream shapes the clients read: Anthropic messages and OpenAI responses events.
const shapes = {
  messages: [
    'event: message_start\ndata: {"type":"message_start"}\n\n',
    'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"text":"Hel"}}\n\n',
    'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"text":"lo ✓"}}\n\n',
    'event: message_stop\ndata: {"type":"message_stop"}\n\n',
  ],
  responses: [
    'event: response.created\ndata: {"type":"response.created"}\n\n',
    'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"Hel"}\n\n',
    'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"lo ✓"}\n\n',
    'event: response.completed\ndata: {"type":"response.completed"}\n\n',
  ],
};

/**
 * The pool as the router sees it when the platform takes the entry down mid-body: the answer's
 * first frames arrive, then the binding's body breaks. The resume route answers the rest from the
 * offset it is asked for, as the controller's resume does from the container's layer.
 */
async function pool(frames: string[], cutAfter: number) {
  const whole = encoder.encode(frames.join(""));
  const cut = encoder.encode(frames.slice(0, cutAfter).join("")).byteLength;
  let requestId = "";
  const resumes: { requestId: string; from: number; attempt: number }[] = [];
  const env = {
    POOL_APP_SIGNING_KEY: signingKey,
    POOL_SERVICE: {
      fetch: async (request: Request) => {
        const named = await openRouterAttempt(request, signingKey);
        assert.ok(named, "every send the router makes is named");
        if (new URL(request.url).pathname === routerResumePath)
          return routerResume(request, { key: signingKey }, async (input) => {
            resumes.push({ requestId: input.requestId, from: input.from, attempt: named.attempt });
            return new Response(whole.slice(input.from), {
              headers: {
                [streamResumeHeader]: streamResumeVersion,
                [streamResumeFromHeader]: String(input.from),
              },
            });
          });
        requestId = named.requestId;
        let sent = false;
        return new Response(
          new ReadableStream<Uint8Array>({
            pull(controller) {
              if (sent)
                return controller.error(new Error("The script will never generate a response."));
              sent = true;
              controller.enqueue(whole.slice(0, cut));
            },
          }),
          {
            headers: {
              "content-type": "text/event-stream",
              "X-Request-Id": requestId,
              [routerResumeHeader]: await signResumeStamp(signingKey, {
                requestId,
                target,
                boot: "boot-a",
              }),
            },
          },
        );
      },
    },
  };
  return { env, whole: frames.join(""), resumes, requestId: () => requestId, cut };
}

for (const [shape, frames] of Object.entries(shapes))
  test(`a ${shape} stream cut when the entry goes down is resumed by the router, every byte once`, async () => {
    const p = await pool(frames, 2);
    const response = await forwardModelCall(
      new Request("https://app.example/v1/messages", { method: "POST", body: "{}" }),
      p.env,
      undefined,
      noWait,
    );
    assert.equal(
      response.headers.has(routerResumeHeader),
      false,
      "the stamp never reaches a client",
    );
    assert.equal(await response.text(), p.whole);
    // Sends are attempts 1 and 2; a resume takes the next number under the same request id.
    assert.deepEqual(p.resumes, [{ requestId: p.requestId(), from: p.cut, attempt: 3 }]);
  });

test("a stamp resumes only the call its router named", async () => {
  const requestId = "1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d";
  const other = "9f8e7d6c-5b4a-4392-8170-6f5e4d3c2b1a";
  const stamp = await signResumeStamp(signingKey, { requestId, target, boot: "boot-a" });
  let resumed = 0;
  const ask = async (headers: Record<string, string>, body: unknown) =>
    (
      await routerResume(
        new Request(`https://pool.example${routerResumePath}`, {
          method: "POST",
          headers,
          body: JSON.stringify(body),
        }),
        { key: signingKey },
        async () => {
          resumed++;
          return new Response("rest");
        },
      )
    ).status;
  const named = async (id: string, key = signingKey) => ({
    [routerAttemptHeader]: await signRouterAttempt(key, { requestId: id, attempt: 2 }),
  });
  // Another caller's router name, a forged name, no name, a forged stamp, a bad offset.
  assert.equal(await ask(await named(other), { stamp, from: 10 }), 403);
  assert.equal(await ask(await named(requestId, "ef".repeat(32)), { stamp, from: 10 }), 403);
  assert.equal(await ask({}, { stamp, from: 10 }), 403);
  const forged = await signResumeStamp("ef".repeat(32), { requestId, target, boot: "boot-a" });
  assert.equal(await ask(await named(requestId), { stamp: forged, from: 10 }), 403);
  assert.equal(await ask(await named(requestId), { stamp, from: -1 }), 403);
  assert.equal(resumed, 0);
  assert.equal(await ask(await named(requestId), { stamp, from: 10 }), 200);
  assert.equal(resumed, 1);
});

for (const [shape, frames] of Object.entries(shapes))
  test(`a ${shape} stream through the device tunnel is resumed by the router, every byte once`, async () => {
    const p = await pool(frames, 1);
    const sent: TunnelServerFrame[] = [];
    const operation = new TunnelOperation(
      {
        v: 1,
        type: "open",
        id: 3,
        operation: { service: "models", method: "GET", path: "/v1/responses", transport: "http" },
        headers: {},
      },
      (frame) => {
        sent.push(frame);
        if (frame.type === "data")
          operation.output.grant(Buffer.from(frame.bytes, "base64").length);
      },
      () => {},
    );
    operation.output.grant(tunnelLimits.windowBytes);
    await operation.run(
      new Request("https://router.example/native/v1/tunnel", {
        headers: { authorization: "Bearer synthetic" },
      }),
      {
        POOL_APP_SIGNING_KEY: signingKey,
        TOOLS_SERVICE: {
          fetch: async () =>
            Response.json({
              id: "native:test",
              userId: "test",
              policy: { kind: "native", computer: "test", pool: "test", models: true },
            }),
        },
        POOL_SERVICE: p.env.POOL_SERVICE,
      },
    );
    assert.equal(
      sent.some((frame) => frame.type === "error"),
      false,
    );
    const bytes = Buffer.concat(
      sent.flatMap((frame) => (frame.type === "data" ? [Buffer.from(frame.bytes, "base64")] : [])),
    );
    assert.equal(bytes.toString("utf8"), p.whole);
    assert.equal(sent.at(-1)?.type, "end");
    assert.equal(p.resumes.length, 1);
  });
