// The load tests' pool: a local HTTP server answering each request with the next scripted answer,
// and the test device and clock the runs use.
import { randomUUID } from "node:crypto";
import { createServer, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { nativeModelHeader } from "../../../src/pool/native-contract.ts";
import { nativeRuntimeUnavailable } from "../../../src/pool/runtime-unavailable.ts";
import { acceptanceCredential } from "../../release/acceptance-device.ts";
import { PoolAcceptanceClient } from "../client.ts";
import type { Clock } from "../load-call.ts";
import { parseLoadShape, type LoadShape } from "../load-shape.ts";
import { runLoad, summaryLines } from "../load.ts";

export const device = {
  computer: "computer-load-7c21",
  grant: "native:grant-load-3e90",
  user: "person-load-51ad",
  pool: "acceptance-load-proof",
};
export const deviceEnv = {
  POOL_ACCEPTANCE_DEVICE: JSON.stringify(device),
  POOL_APP_SIGNING_KEY: "cd".repeat(32),
};
export const boot = "boot-load-9f13";
export const go = "coordinator-2026-11-26-load-proof";

/** Real time that a stand-in can move on, and waits that pass at once by moving it. */
export function testClock() {
  let skew = 0;
  const clock: Clock & { advance(ms: number): void } = {
    now: () => performance.now() + skew,
    wall: () => Date.now() + skew,
    sleep: async (ms) => {
      skew += Math.max(0, ms);
    },
    advance: (ms) => {
      skew += ms;
    },
  };
  return clock;
}

// aimock 1.48.1's short streams, framed as scripts/emulated-upstream/emulated-upstream.test.mjs
// captured them.
export const sse = (frames: readonly unknown[]) =>
  frames.map((frame) => `data: ${typeof frame === "string" ? frame : JSON.stringify(frame)}\n\n`);
export const streams: Record<string, (content: string) => string[]> = {
  "/v1/chat/completions": (content) =>
    sse([
      { choices: [{ delta: { role: "assistant", content: "" }, finish_reason: null }] },
      { choices: [{ delta: { content }, finish_reason: null }] },
      { choices: [{ delta: {}, finish_reason: "stop" }] },
      { choices: [], usage: { prompt_tokens: 11, completion_tokens: 2 } },
      "[DONE]",
    ]),
  "/v1/messages": (content) =>
    sse([
      { type: "message_start", message: { usage: { input_tokens: 11, output_tokens: 2 } } },
      { type: "content_block_delta", delta: { type: "text_delta", text: content } },
      { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 2 } },
      { type: "message_stop" },
    ]),
  "/v1/responses": (content) =>
    sse([
      { type: "response.output_text.delta", delta: content },
      { type: "response.completed", response: { usage: { input_tokens: 11, output_tokens: 2 } } },
    ]),
};

export type Answer = (response: ServerResponse, path: string) => void | Promise<void>;
export const streamHeaders = (withBoot: boolean | string = true) => ({
  "content-type": "text/event-stream",
  "X-Request-Id": randomUUID(),
  ...(withBoot ? { "X-Signalbox-Pool-Boot": withBoot === true ? boot : withBoot } : {}),
});
export const streamed =
  ({
    content = "OK",
    withBoot = true as boolean | string,
    body = undefined as string | undefined,
    beforeFirstByte = () => {},
  } = {}): Answer =>
  (response, path) => {
    response.writeHead(200, streamHeaders(withBoot));
    beforeFirstByte();
    response.end(body ?? streams[path]!(content).join(""));
  };
/** The pool's own retryable refusal (src/pool/runtime-unavailable.ts), as the entry relays it. */
export const unavailable: Answer = async (response, path) => {
  const refusal = nativeRuntimeUnavailable(
    new Request(`https://pool.invalid${path}`, { method: "POST" }),
  );
  response.writeHead(refusal.status, {
    ...Object.fromEntries(refusal.headers),
    "X-Request-Id": randomUUID(),
    "X-Signalbox-Pool-Boot": boot,
  });
  response.end(await refusal.text());
};

export async function stage(answers: readonly Answer[]) {
  const seen: { path?: string; traceparent?: string; assertion?: string }[] = [];
  const server = createServer((request, response) => {
    const call = {
      path: request.url,
      traceparent: request.headers.traceparent as string | undefined,
      assertion: request.headers[nativeModelHeader] as string | undefined,
    };
    seen.push(call);
    request.resume();
    answers[Math.min(seen.length, answers.length) - 1]!(response, request.url ?? "");
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const close = () => {
    server.closeAllConnections();
    server.close();
  };
  return { seen, origin, client: new PoolAcceptanceClient({ origin }), close };
}

/** A step of a paced answer: the clock moves this far, then this text arrives. */
export type Step = readonly [advanceMs: number, text: string];

/**
 * A pool whose 200 arrives in steps on the run's clock. It answers in memory, under the client's
 * own `fetch` seam, because only a body the reader pulls orders each chunk's read before the next
 * step moves the clock; a socket may hand two writes over as one read. An empty step only moves
 * the clock, so a last one holds the body open before it ends.
 */
export function pacedPool(
  clock: { advance(ms: number): void },
  steps: readonly Step[],
  withBoot: boolean | string = true,
  beforeAnswer: () => void = () => {},
) {
  const seen: { path: string }[] = [];
  const encoder = new TextEncoder();
  const client = new PoolAcceptanceClient({
    origin: "https://pool.invalid",
    fetch: async (input) => {
      seen.push({ path: new URL(input.toString()).pathname });
      beforeAnswer();
      let next = 0;
      const body = new ReadableStream<Uint8Array>(
        {
          pull(controller) {
            for (; next < steps.length;) {
              const [advanceMs, text] = steps[next++]!;
              clock.advance(advanceMs);
              if (text) return controller.enqueue(encoder.encode(text));
            }
            controller.close();
          },
        },
        { highWaterMark: 0 },
      );
      return new Response(body, { status: 200, headers: streamHeaders(withBoot) });
    },
  });
  return { seen, client };
}

/** One frame's line, with no line ending: the last line of a body may lack one. */
export const dataLine = (frame: unknown) =>
  `data: ${typeof frame === "string" ? frame : JSON.stringify(frame)}`;
export const frame = (value: unknown) => `${dataLine(value)}\n\n`;

export const chatOnly = (calls: number, extra: Record<string, unknown> = {}) =>
  parseLoadShape(
    JSON.stringify({
      concurrency: 1,
      durationMinutes: 1,
      calls,
      mix: [{ shape: "chat", weight: 1 }],
      ...extra,
    }),
  );

export async function load(
  answers: readonly Answer[],
  shape: number | LoadShape,
  clock = testClock(),
  kill?: () => number | undefined,
) {
  const pool = await stage(answers);
  try {
    const loadShape = typeof shape === "number" ? chatOnly(shape) : shape;
    const run = await runLoad({
      client: pool.client,
      credential: acceptanceCredential(deviceEnv),
      shape: loadShape,
      clock,
      kill,
    });
    return { run, seen: pool.seen, lines: summaryLines(run, loadShape) };
  } finally {
    pool.close();
  }
}
