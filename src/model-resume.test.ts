import assert from "node:assert/strict";
import { test } from "node:test";
import { forwardModelCall } from "./model-replay.ts";
import type { StreamResumeInput } from "./pool/stream-splice.ts";
import { signEnvelope } from "./pool/token.ts";
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
async function pool(
  frames: string[],
  cutAfter: number,
  ending: "error" | "end" = "error",
  stamped = true,
) {
  const whole = encoder.encode(frames.join(""));
  const cut = encoder.encode(frames.slice(0, cutAfter).join("")).byteLength;
  let requestId = "";
  const resumes: { requestId: string; from: number; attempt: number }[] = [];
  const calls: (StreamResumeInput["call"] | undefined)[] = [];
  const env = {
    POOL_APP_SIGNING_KEY: signingKey,
    POOL_SERVICE: {
      fetch: async (request: Request) => {
        const named = await openRouterAttempt(request, signingKey);
        assert.ok(named, "every send the router makes is named");
        if (new URL(request.url).pathname === routerResumePath)
          return routerResume(request, { key: signingKey }, async (input) => {
            resumes.push({ requestId: input.requestId, from: input.from, attempt: named.attempt });
            calls.push(input.call);
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
              // As real workerd shows it, the binding's body may just end where the pool went down.
              if (sent)
                return ending === "end"
                  ? controller.close()
                  : controller.error(new Error("The script will never generate a response."));
              sent = true;
              controller.enqueue(whole.slice(0, cut));
            },
          }),
          {
            headers: {
              "content-type": "text/event-stream",
              "X-Request-Id": requestId,
              ...(stamped
                ? {
                    [routerResumeHeader]: await signResumeStamp(signingKey, {
                      requestId,
                      target,
                      boot: "boot-a",
                    }),
                  }
                : {}),
            },
          },
        );
      },
    },
  };
  return { env, whole: frames.join(""), resumes, calls, requestId: () => requestId, cut };
}

test("the router's resume carries the call's own method, path and credentials, signed afresh", async () => {
  const p = await pool(shapes.messages, 2);
  let signed = 0;
  const response = await forwardModelCall(
    new Request("https://app.example/v1/messages?beta=true", {
      method: "POST",
      headers: { "x-api-key": "caller-key", "content-type": "application/json" },
      body: "{}",
    }),
    p.env,
    // As a device call's assertion is signed for each send.
    async (headers) => headers.set("x-fixture-assertion", String(++signed)),
    noWait,
  );
  assert.equal(await response.text(), p.whole);
  const [call] = p.calls;
  assert.equal(call?.method, "POST");
  assert.equal(call?.path, "/v1/messages?beta=true");
  const headers = new Headers(call?.headers);
  assert.equal(headers.get("x-api-key"), "caller-key");
  assert.equal(headers.get("x-fixture-assertion"), "2", "a send of its own, signed for the resume");
  assert.equal(headers.has(routerAttemptHeader), false, "the router's name is not the caller's");
});

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
  const callOf = { method: "POST", path: "/v1/messages" };
  // Another caller's router name, a forged name, no name, a forged stamp, a bad offset, no call.
  assert.equal(await ask(await named(other), { stamp, from: 10, ...callOf }), 403);
  assert.equal(
    await ask(await named(requestId, "ef".repeat(32)), { stamp, from: 10, ...callOf }),
    403,
  );
  assert.equal(await ask({}, { stamp, from: 10, ...callOf }), 403);
  const forged = await signResumeStamp("ef".repeat(32), { requestId, target, boot: "boot-a" });
  assert.equal(await ask(await named(requestId), { stamp: forged, from: 10, ...callOf }), 403);
  assert.equal(await ask(await named(requestId), { stamp, from: -1, ...callOf }), 403);
  assert.equal(await ask(await named(requestId), { stamp, from: 10 }), 403);
  assert.equal(resumed, 0);
  assert.equal(await ask(await named(requestId), { stamp, from: 10, ...callOf }), 200);
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
        operation: { service: "models", method: "POST", path: "/v1/responses", transport: "http" },
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
    // The device's upload is complete before the answer starts.
    operation.end();
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

for (const [shape, frames] of Object.entries(shapes))
  test(`a ${shape} stream that just ends before its terminal event is resumed like a cut`, async () => {
    const p = await pool(frames, 2, "end");
    const response = await forwardModelCall(
      new Request("https://app.example/v1/messages", { method: "POST", body: "{}" }),
      p.env,
      undefined,
      noWait,
    );
    assert.equal(await response.text(), p.whole);
    assert.equal(p.resumes.length, 1);
  });

test("an answer the entry did not stamp ends exactly as it ended before", async () => {
  const p = await pool(shapes.messages, 2, "end", false);
  const response = await forwardModelCall(
    new Request("https://app.example/v1/messages", { method: "POST", body: "{}" }),
    p.env,
    undefined,
    noWait,
  );
  assert.equal(await response.text(), shapes.messages.slice(0, 2).join(""));
  assert.equal(p.resumes.length, 0);
});

/**
 * A pool whose answer and each resumed part end cleanly after the given numbers of frames, as a pool
 * that goes down again mid-resume does. The resume route serves from the offset it is asked for.
 */
async function cuttingPool(
  text: string,
  segments: number[],
  options: { notReadyFirst?: boolean; path?: string } = {},
) {
  const whole = encoder.encode(text);
  const ends = segments.map(
    (frames) =>
      encoder.encode(text.split("\n\n").slice(0, frames).join("\n\n") + "\n\n").byteLength,
  );
  const resumes: number[] = [];
  let notReady = options.notReadyFirst === true;
  const part = (from: number, index: number, headers: Record<string, string>) => {
    const end = ends[index] ?? whole.byteLength;
    let sent = false;
    return new Response(
      new ReadableStream<Uint8Array>({
        pull(controller) {
          if (sent) return controller.close();
          sent = true;
          controller.enqueue(whole.slice(from, end));
        },
      }),
      { headers },
    );
  };
  const env = {
    POOL_APP_SIGNING_KEY: signingKey,
    POOL_SERVICE: {
      fetch: async (request: Request) => {
        const named = (await openRouterAttempt(request, signingKey))!;
        if (new URL(request.url).pathname === routerResumePath)
          return routerResume(request, { key: signingKey }, async (input) => {
            if (notReady) {
              notReady = false;
              throw new Error("Durable Object instance is no longer active");
            }
            resumes.push(input.from);
            return part(input.from, resumes.length, {
              [streamResumeHeader]: streamResumeVersion,
              [streamResumeFromHeader]: String(input.from),
            });
          });
        return part(0, 0, {
          "content-type": "text/event-stream",
          "X-Request-Id": named.requestId,
          [routerResumeHeader]: await signResumeStamp(signingKey, {
            requestId: named.requestId,
            target,
            boot: "boot-a",
          }),
        });
      },
    },
  };
  const response = await forwardModelCall(
    new Request(`https://app.example${options.path ?? "/v1/messages"}`, {
      method: "POST",
      body: "{}",
    }),
    env,
    undefined,
    noWait,
  );
  return { text: await response.text(), resumes, ends };
}

test("a second clean cut inside a resumed part is resumed too, and the answer arrives whole", async () => {
  const text = shapes.messages.join("");
  const result = await cuttingPool(text, [1, 3]);
  assert.equal(result.text, text);
  assert.deepEqual(result.resumes, [result.ends[0], result.ends[1]]);
});

test("a resume that finds the controller not back yet is tried again", async () => {
  const text = shapes.responses.join("");
  const result = await cuttingPool(text, [2], { notReadyFirst: true, path: "/v1/responses" });
  assert.equal(result.text, text);
  assert.equal(result.resumes.length, 1);
});

test("a finished stream is never taken for a cut, whatever follows its terminal event", async () => {
  for (const tail of ["\n\n", ": ping\n\n", "event: ping\n\n"]) {
    const text = shapes.messages.join("") + tail;
    const result = await cuttingPool(text, [shapes.messages.length + 2]);
    assert.equal(result.text, text);
    assert.deepEqual(result.resumes, [], JSON.stringify(tail));
  }
});

test("a chat completions stream that ends with an error object is whole", async () => {
  const text =
    'data: {"choices":[{"delta":{"content":"Hi"}}]}\n\ndata: {"error":{"message":"x"}}\n\n';
  const result = await cuttingPool(text, [9], { path: "/v1/chat/completions" });
  assert.equal(result.text, text);
  assert.deepEqual(result.resumes, []);
});

test("a cut just before the terminal event's closing blank line is still a cut", async () => {
  const text = shapes.messages.join("");
  const whole = encoder.encode(text);
  // The resumed part ends two bytes short: the terminal event's data is there, its blank line not.
  const result = await cuttingPool(text, [1, 99], {});
  assert.equal(result.text, text);
  const short = await cuttingPoolBytes(text, [whole.byteLength - 2]);
  assert.equal(short.text, text);
  assert.equal(short.resumes.length, 1);
});

test("a ping that carries data after the terminal event leaves a finished stream finished", async () => {
  const text = shapes.messages.join("") + 'event: ping\ndata: {"type":"ping"}\n\n';
  const result = await cuttingPool(text, [shapes.messages.length + 2]);
  assert.equal(result.text, text);
  assert.deepEqual(result.resumes, []);
});

test("an event larger than the judge holds is still judged by its type", async () => {
  const big = `event: response.completed\ndata: {"type":"response.completed","response":{"output":"${"x".repeat(300 * 1024)}"}}\n\n`;
  const text = shapes.responses.slice(0, 3).join("") + big;
  const whole = encoder.encode(text).byteLength;
  const cut = await cuttingPoolBytes(text, [whole - 1000], "/v1/responses");
  assert.equal(cut.text, text);
  assert.equal(cut.resumes.length, 1);
  const finished = await cuttingPoolBytes(text, [whole], "/v1/responses");
  assert.equal(finished.text, text);
  assert.equal(finished.resumes.length, 0);
});

/** As `cuttingPool`, with each part ending at an exact byte offset. */
function cuttingPoolBytes(text: string, offsets: number[], path = "/v1/messages") {
  return cuttingPoolChunks(text, offsets, 4093, path);
}

async function cuttingPoolChunks(
  text: string,
  offsets: number[],
  size: number,
  path = "/v1/messages",
) {
  const whole = encoder.encode(text);
  const resumes: number[] = [];
  // In reads of `size` bytes, so a large event spans many of them, as it does from a binding.
  const part = (from: number, end: number, headers: Record<string, string>) => {
    let offset = from;
    return new Response(
      new ReadableStream<Uint8Array>({
        pull(controller) {
          if (offset >= end) return controller.close();
          controller.enqueue(whole.slice(offset, Math.min(end, offset + size)));
          offset += size;
        },
      }),
      { headers },
    );
  };
  const env = {
    POOL_APP_SIGNING_KEY: signingKey,
    POOL_SERVICE: {
      fetch: async (request: Request) => {
        const named = (await openRouterAttempt(request, signingKey))!;
        if (new URL(request.url).pathname === routerResumePath)
          return routerResume(request, { key: signingKey }, async (input) => {
            resumes.push(input.from);
            return part(input.from, offsets[resumes.length] ?? whole.byteLength, {
              [streamResumeHeader]: streamResumeVersion,
              [streamResumeFromHeader]: String(input.from),
            });
          });
        return part(0, offsets[0] ?? whole.byteLength, {
          "content-type": "text/event-stream",
          "X-Request-Id": named.requestId,
          [routerResumeHeader]: await signResumeStamp(signingKey, {
            requestId: named.requestId,
            target,
            boot: "boot-a",
          }),
        });
      },
    },
  };
  const response = await forwardModelCall(
    new Request(`https://app.example${path}`, { method: "POST", body: "{}" }),
    env,
    undefined,
    noWait,
  );
  return { text: await response.text(), resumes };
}

test("a large terminal event whose type is not its first key is still judged by its name", async () => {
  const big = `event: response.completed\ndata: {"sequence_number":9,"type":"response.completed","response":{"output":"${"x".repeat(300 * 1024)}"}}\n\n`;
  const text = shapes.responses.slice(0, 3).join("") + big;
  const whole = encoder.encode(text).byteLength;
  const finished = await cuttingPoolBytes(text, [whole], "/v1/responses");
  assert.equal(finished.text, text);
  assert.equal(finished.resumes.length, 0);
  const cut = await cuttingPoolBytes(text, [whole - 1000], "/v1/responses");
  assert.equal(cut.text, text);
  assert.equal(cut.resumes.length, 1);
});

test("event boundaries split across reads anywhere, \\r\\n or \\n, are found", async () => {
  for (const newline of ["\n", "\r\n"]) {
    const text = shapes.messages.join("").replaceAll("\n", newline);
    const whole = encoder.encode(text).byteLength;
    // One byte at a time: every boundary falls across reads.
    const finished = await cuttingPoolChunks(text, [whole], 1);
    assert.equal(finished.text, text);
    assert.equal(finished.resumes.length, 0, JSON.stringify(newline));
    const cut = await cuttingPoolChunks(text, [whole - 2], 1);
    assert.equal(cut.text, text);
    assert.equal(cut.resumes.length, 1, JSON.stringify(newline));
  }
});

test("a stamp that does not open leaves the answer untouched: wrong key, expired, another call", async () => {
  const frames = shapes.messages.slice(0, 2).join("");
  const stamps = {
    "wrong key": async () =>
      signResumeStamp("ef".repeat(32), { requestId: "", target, boot: "boot-a" }),
    expired: async (requestId: string) =>
      signEnvelope(signingKey, "sbrs1", {
        requestId,
        target,
        boot: "boot-a",
        expiresAt: Date.now() - 1,
      }),
    "another call": async () =>
      signResumeStamp(signingKey, {
        requestId: "00000000-0000-4000-8000-000000000000",
        target,
        boot: "boot-a",
      }),
  };
  for (const [label, stamp] of Object.entries(stamps)) {
    let resumes = 0;
    const response = await forwardModelCall(
      new Request("https://app.example/v1/messages", { method: "POST", body: "{}" }),
      {
        POOL_APP_SIGNING_KEY: signingKey,
        POOL_SERVICE: {
          fetch: async (request: Request) => {
            const named = (await openRouterAttempt(request, signingKey))!;
            if (new URL(request.url).pathname === routerResumePath) resumes++;
            return new Response(frames, {
              headers: {
                "content-type": "text/event-stream",
                "X-Request-Id": named.requestId,
                [routerResumeHeader]: await stamp(named.requestId),
              },
            });
          },
        },
      },
      undefined,
      noWait,
    );
    assert.equal(response.headers.has(routerResumeHeader), false, label);
    // The truncated answer ends exactly as it did: cleanly, byte for byte, never resumed.
    assert.equal(await response.text(), frames, label);
    assert.equal(resumes, 0, label);
  }
});

test("a chat completions stream cut before [DONE] is resumed; one that ends with [DONE] is whole", async () => {
  const text =
    'data: {"choices":[{"delta":{"content":"Hi"}}]}\n\ndata: {"choices":[{"delta":{"content":" there"}}]}\n\ndata: [DONE]\n\n';
  const whole = encoder.encode(text).byteLength;
  const finished = await cuttingPoolBytes(text, [whole], "/v1/chat/completions");
  assert.equal(finished.text, text);
  assert.equal(finished.resumes.length, 0);
  const cut = await cuttingPoolBytes(text, [whole - 14], "/v1/chat/completions");
  assert.equal(cut.text, text);
  assert.equal(cut.resumes.length, 1);
});

test("response.done ends a responses stream", async () => {
  const text =
    shapes.responses.slice(0, 3).join("") +
    'event: response.done\ndata: {"type":"response.done","response":{}}\n\n';
  const result = await cuttingPoolBytes(text, [encoder.encode(text).byteLength], "/v1/responses");
  assert.equal(result.text, text);
  assert.equal(result.resumes.length, 0);
});

test("an oversized last event whose type cannot be read is taken as whole, as the entry takes it", async () => {
  const big = `data: {"sequence_number":9,"response":{"output":"${"x".repeat(300 * 1024)}"},"type":"response.completed"}\n\n`;
  const text = 'data: {"type":"response.created"}\n\n' + big;
  const whole = encoder.encode(text).byteLength;
  const finished = await cuttingPoolBytes(text, [whole], "/v1/responses");
  assert.equal(finished.text, text);
  assert.equal(finished.resumes.length, 0);
  // Cut inside it, the event never closed: still a cut.
  const cut = await cuttingPoolBytes(text, [whole - 1000], "/v1/responses");
  assert.equal(cut.text, text);
  assert.equal(cut.resumes.length, 1);
});

test("an oversized event whose type is readable and not a terminal is no reason to call the answer whole", async () => {
  const big = `event: response.output_text.done\ndata: {"type":"response.output_text.done","text":"${"x".repeat(300 * 1024)}"}\n\n`;
  const text = shapes.responses.slice(0, 2).join("") + big + shapes.responses.at(-1);
  const afterBig = encoder.encode(shapes.responses.slice(0, 2).join("") + big).byteLength;
  const cut = await cuttingPoolBytes(text, [afterBig], "/v1/responses");
  assert.equal(cut.text, text);
  assert.equal(cut.resumes.length, 1);
});
