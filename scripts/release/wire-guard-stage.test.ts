import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { Effect } from "effect";
import type { StageScope } from "./stage-writes.ts";
import { install, WireRefused } from "./wire-guard.ts";
import { ACCOUNT, startServer, type ServerOptions } from "./test/wire-guard-fixture.ts";

const scope: StageScope = {
  stack: "basalt-rehearsal",
  stage: "test-rehearsal-2",
  label: "rehearsal-2",
  databases: ["basalt-preview-rehearsal-2"],
  owned: [],
};

/** Sends each request through the installed guard; a refusal is returned, not thrown. */
const sendAll = async (
  context: TestContext,
  options: ServerOptions,
  requests: ReadonlyArray<(base: string) => [string, RequestInit]>,
) => {
  const server = await startServer(options);
  context.after(server.close);
  const results = await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const guard = yield* install({ stage: scope });
        const out: Array<number | WireRefused> = [];
        for (const request of requests) {
          const [url, init] = request(server.base);
          out.push(
            yield* Effect.promise(() =>
              guard
                .fetch(url, init)
                .then((response) => response.status)
                .catch((error: unknown) => {
                  if (error instanceof WireRefused) return error;
                  throw error;
                }),
            ),
          );
        }
        return out;
      }),
    ),
  );
  return { results, sent: server.received.map((r) => `${r.method} ${r.path}`) };
};
const json = (method: string, body: unknown = {}): RequestInit => ({
  method,
  headers: { "content-type": "application/json", authorization: "Bearer synthetic" },
  body: JSON.stringify(body),
});
const script = (base: string, name: string) =>
  `${base}/accounts/${ACCOUNT}/workers/scripts/${name}`;

test("a stage uploads a Worker its State never recorded only once Cloudflare shows it is new or the stage's", async (t) => {
  const { results, sent } = await sendAll(
    t,
    {
      scriptTags: {
        "basalt-production-api": [
          "alchemy:stack:basalt",
          "alchemy:stage:production",
          "alchemy:id:Api",
        ],
        "stage-api": [
          "alchemy:stack:basalt-rehearsal",
          "alchemy:stage:test-rehearsal-2",
          "alchemy:id:Api",
        ],
      },
    },
    [
      (base) => [script(base, "new-worker"), json("PUT")],
      // Proven once, it is the stage's for the rest of the run.
      (base) => [script(base, "new-worker"), json("PUT")],
      (base) => [script(base, "stage-api"), json("PUT")],
      (base) => [script(base, "basalt-production-api"), json("PUT")],
    ],
  );
  assert.deepEqual(results.slice(0, 3), [200, 200, 200]);
  const refused = results[3];
  assert.ok(refused instanceof WireRefused);
  assert.equal(refused.field, "owner");
  assert.equal(refused.resource, "Worker basalt-production-api");
  // Production's Worker was read, never written.
  assert.deepEqual(
    sent.map((line) => line.replace(ACCOUNT, "{account}")),
    [
      "GET /accounts/{account}/workers/scripts/new-worker/settings",
      "PUT /accounts/{account}/workers/scripts/new-worker",
      "PUT /accounts/{account}/workers/scripts/new-worker",
      "GET /accounts/{account}/workers/scripts/stage-api/settings",
      "PUT /accounts/{account}/workers/scripts/stage-api",
      "GET /accounts/{account}/workers/scripts/basalt-production-api/settings",
    ],
  );
});

test("what a stage creates is its own for the rest of the run, and nothing else by id is", async (t) => {
  const applications = (base: string) => `${base}/accounts/${ACCOUNT}/containers/applications`;
  const { results, sent } = await sendAll(t, { createdId: "app-created-here" }, [
    (base) => [applications(base), json("POST", { name: "basalt-rehearsal-root" })],
    (base) => [`${applications(base)}/app-created-here`, json("PATCH")],
    (base) => [`${applications(base)}/app-production-root`, json("PATCH")],
  ]);
  assert.deepEqual(results.slice(0, 2), [200, 200]);
  assert.ok(results[2] instanceof WireRefused);
  assert.equal(sent.length, 2);
});

test("a stage never writes another stack's or stage's State, nor drops a whole stack", async (t) => {
  const state = (base: string, path: string) => `${base}/state/stacks/${path}`;
  const { results, sent } = await sendAll(t, {}, [
    (base) => [state(base, "basalt-rehearsal/stages/test-rehearsal-2/resources/Api"), json("PUT")],
    (base) => [state(base, "basalt/stages/production/resources/Api"), json("PUT")],
    (base) => [state(base, "basalt"), { method: "DELETE" }],
  ]);
  assert.equal(results[0], 200);
  assert.ok(results[1] instanceof WireRefused && results[1].field === "stage");
  assert.ok(results[2] instanceof WireRefused);
  assert.deepEqual(sent, [
    "PUT /state/stacks/basalt-rehearsal/stages/test-rehearsal-2/resources/Api",
  ]);
});

test("a read of production sends reads only; any write is refused before it leaves", async (t) => {
  const server = await startServer();
  t.after(server.close);
  const outcomes = await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const guard = yield* install({ readOnly: true });
        const send = (url: string, init: RequestInit) =>
          Effect.promise(() =>
            guard
              .fetch(url, init)
              .then((response) => response.status)
              .catch((error: unknown) => (error instanceof WireRefused ? error.field : "error")),
          );
        return [
          yield* send(script(server.base, "basalt-production-api"), { method: "GET" }),
          yield* send(script(server.base, "basalt-production-api"), json("PUT")),
          yield* send(`${server.base}/accounts/${ACCOUNT}/hyperdrive/configs`, json("POST")),
        ];
      }),
    ),
  );
  assert.deepEqual(outcomes, [200, "method", "method"]);
  assert.deepEqual(
    server.received.map((r) => r.method),
    ["GET"],
  );
});
