// A stand-in for aimock behind the container's port. It refuses a call without its key the way
// aimock does, answers the stage's two prompts in each shape with the recorded answers, and acts on
// the chaos headers like aimock 1.48.1: the latency moves the test's clock before anything else,
// and a 429 share above the draw answers the chaos 429. `calls` lists what each request carried,
// for assertions only.
import { countingText } from "../fixtures.mjs";
import { longMatch } from "../prompts.ts";
import { chaos429Body, chaos429Headers, streamOf, wholeOf } from "./aimock-shapes.mjs";

const shapes = {
  "/v1/chat/completions": "chat",
  "/v1/responses": "responses",
  "/v1/messages": "messages",
};

/**
 * `clock.ms` is the test's clock; a long stream advances it by `longMs`. With `chaos: false` the
 * mock ignores every chaos header, as a Worker that dropped them would leave it.
 */
export function fakeAimock({ key, clock = { ms: 0 }, longMs = 60_000, chaos = true, draw = 0.5 }) {
  const calls = [];
  const port = {
    async fetch(input, init) {
      // The Worker forwards a Request; the mock's own refusal calls with a URL and its options.
      const request = input instanceof Request ? input : new Request(input, init);
      const { pathname, search } = new URL(request.url);
      const header = (name) => request.headers.get(name) ?? undefined;
      const call = { method: request.method, path: pathname, search };
      call.chaos = Object.fromEntries(
        [...request.headers].filter(([name]) => name.startsWith("x-aimock-chaos-")),
      );
      calls.push(call);
      // aimock's health route answers before its key check, as mock-start.ts relies on.
      if (pathname === "/health") return new Response(null, { status: 200 });
      const given =
        /^Bearer (.+)$/u.exec(header("authorization") ?? "")?.[1] ?? header("x-api-key");
      if (given !== key)
        return Response.json(
          { error: { message: "Invalid API key", type: "authentication_error" } },
          { status: 401, headers: { "www-authenticate": 'Bearer realm="aimock"' } },
        );
      const shape = shapes[pathname];
      if (!shape) return Response.json({ error: { type: "not_found" } }, { status: 404 });
      if (chaos) {
        clock.ms += Number(header("x-aimock-chaos-latency") ?? 0);
        if (Number(header("x-aimock-chaos-ratelimit") ?? 0) > draw)
          return new Response(chaos429Body, { status: 429, headers: chaos429Headers });
      }
      const sent = await request.json();
      const prompt = sent.input ?? sent.messages?.[0]?.content ?? "";
      const long = prompt.startsWith(longMatch);
      const usage = long ? { input: 22, output: 3000 } : { input: 11, output: 2 };
      if (long) clock.ms += longMs;
      const text = long ? countingText : "OK";
      return sent.stream === false
        ? new Response(wholeOf(shape, text, usage), {
            headers: { "content-type": "application/json" },
          })
        : new Response(streamOf(shape, text, usage), {
            headers: { "content-type": "text/event-stream" },
          });
    },
  };
  return { port, calls, clock };
}

/** Profile b's store as the mock's Durable Object keeps it, in memory. */
export function memoryStore(chaos = { rateLimitRate: 0, latencyMs: 0 }) {
  const store = {
    value: chaos,
    read: async () => store.value,
    write: async (next) => {
      store.value = next;
    },
  };
  return store;
}
