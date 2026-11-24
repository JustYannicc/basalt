import assert from "node:assert/strict";
import { test } from "node:test";
import { forwardModelCall, routerHoldBytes, routerReplayCeiling } from "./model-replay.ts";
import { openRouterAttempt } from "./pool/router-attempt.ts";

const signingKey = "cd".repeat(32);
const noWait = async () => {};
const call = (body = '{"model":"synthetic"}', init: RequestInit = {}) =>
  new Request("https://app.signalbox.run/v1/messages", { method: "POST", body, ...init });
// What the service binding rejects with when the pool Worker's isolate goes under the call.
const cancelled = () => new Error("The script will never generate a response.");

async function unknown(response: Response) {
  assert.equal(response.status, 502);
  assert.equal(response.headers.get("retry-after"), "1");
  assert.equal(response.headers.get("x-should-retry"), null);
  const body = (await response.json()) as { error: { code: string; retryable: boolean } };
  assert.equal(body.error.code, "upstream_outcome_unknown");
  assert.equal(body.error.retryable, true);
}

test("both sends of one call carry the router's request id, and the caller sees that id", async () => {
  const named: { requestId: string; attempt: number }[] = [];
  const response = await forwardModelCall(
    call(),
    {
      POOL_APP_SIGNING_KEY: signingKey,
      POOL_SERVICE: {
        fetch: async (request) => {
          named.push((await openRouterAttempt(request, signingKey))!);
          if (named.length === 1) throw cancelled();
          return Response.json({}, { headers: { "X-Request-Id": named[0]!.requestId } });
        },
      },
    },
    undefined,
    noWait,
  );
  assert.equal(response.status, 200);
  assert.equal(named.length, 2);
  assert.equal(named[0]!.requestId, named[1]!.requestId);
  assert.deepEqual(
    named.map((value) => value.attempt),
    [1, 2],
  );
  assert.equal(response.headers.get("x-request-id"), named[0]!.requestId);
});

test("a call lost twice keeps today's answer, under its own request id", async () => {
  let sends = 0;
  let requestId: string | undefined;
  const response = await forwardModelCall(
    call(),
    {
      POOL_APP_SIGNING_KEY: signingKey,
      POOL_SERVICE: {
        fetch: async (request) => {
          sends++;
          requestId = (await openRouterAttempt(request, signingKey))!.requestId;
          throw cancelled();
        },
      },
    },
    undefined,
    noWait,
  );
  assert.equal(sends, 2);
  assert.equal(response.headers.get("x-request-id"), requestId);
  await unknown(response);
});

test("an error the platform marks overloaded is never sent again", async () => {
  let sends = 0;
  const response = await forwardModelCall(
    call(),
    {
      POOL_APP_SIGNING_KEY: signingKey,
      POOL_SERVICE: {
        fetch: async () => {
          sends++;
          throw Object.assign(new Error("Durable Object is overloaded."), { overloaded: true });
        },
      },
    },
    undefined,
    noWait,
  );
  assert.equal(sends, 1);
  await unknown(response);
});

test("a caller who left is not sent again", async () => {
  const left = new AbortController();
  let sends = 0;
  const response = await forwardModelCall(
    call(undefined, { signal: left.signal }),
    {
      POOL_APP_SIGNING_KEY: signingKey,
      POOL_SERVICE: {
        fetch: async () => {
          sends++;
          left.abort();
          throw cancelled();
        },
      },
    },
    undefined,
    noWait,
  );
  assert.equal(sends, 1);
  await unknown(response);
});

test("a body over the hold bound is sent once and keeps today's answer", async () => {
  let sends = 0;
  const response = await forwardModelCall(
    call("x".repeat(routerHoldBytes + 1)),
    {
      POOL_APP_SIGNING_KEY: signingKey,
      POOL_SERVICE: {
        fetch: async (request) => {
          sends++;
          await request.arrayBuffer();
          throw cancelled();
        },
      },
    },
    undefined,
    noWait,
  );
  assert.equal(sends, 1);
  await unknown(response);
});

test("a job route is never sent again", async () => {
  let sends = 0;
  const response = await forwardModelCall(
    new Request("https://app.signalbox.run/v1/images/generations", { method: "POST", body: "{}" }),
    {
      POOL_APP_SIGNING_KEY: signingKey,
      POOL_SERVICE: {
        fetch: async () => {
          sends++;
          throw cancelled();
        },
      },
    },
    undefined,
    noWait,
  );
  assert.equal(sends, 1);
  assert.equal(response.status, 502);
  assert.equal(response.headers.get("x-should-retry"), "false");
});

test("a pool that fails every send gets at most the ceiling in extra sends, however many call", async () => {
  const callers = routerReplayCeiling * 3;
  let sends = 0;
  let release!: () => void;
  const held = new Promise<void>((resolve) => (release = resolve));
  const env = {
    POOL_APP_SIGNING_KEY: signingKey,
    POOL_SERVICE: {
      fetch: async () => {
        sends++;
        throw cancelled();
      },
    },
  };
  // Every replay waits until all first sends have failed, so the replays overlap as in an outage.
  const answers = Array.from({ length: callers }, () =>
    forwardModelCall(call(), env, undefined, () => held),
  );
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(sends, callers);
  release();
  for (const answer of await Promise.all(answers)) await unknown(answer);
  assert.equal(sends - callers, routerReplayCeiling);
});
