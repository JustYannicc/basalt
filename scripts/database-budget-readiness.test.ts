import assert from "node:assert/strict";
import { test } from "node:test";
import { openDeploymentReadiness, bounded } from "./database-budget-readiness.ts";
import { handleDeploymentReadiness } from "../src/pool/deployment-readiness.ts";
const target = { candidate: "a".repeat(40), workerInput: "b".repeat(64), imageHash: "1234abcd" };
const key = "c".repeat(64);

test("the release command uses only the signed private service and strips extra receipt fields", async () => {
  let disposals = 0,
    warms = 0;
  const connection = await openDeploymentReadiness({
    worker: "fixture-worker",
    accountId: "d".repeat(32),
    key,
    target,
    connect: async () => ({
      env: {
        POOL_OPERATIONS: {
          async fetch(request) {
            assert.equal(new URL(request.url).pathname, "/deployment-readiness");
            return handleDeploymentReadiness(request, target, key, async () => {
              warms++;
              return {
                ...target,
                desiredRevisionMatch: true,
                instanceId: "e".repeat(64),
                bootId: "fixture-boot",
                readyAt: Date.now(),
              };
            });
          },
        },
      },
      async dispose() {
        disposals++;
      },
    }),
  });
  try {
    const receipt = await connection.ready(new AbortController().signal);
    assert.equal(receipt.bootId, "fixture-boot");
    assert.equal(warms, 1);
    assert.doesNotMatch(JSON.stringify(receipt), /fixture-worker|http|secret/);
  } finally {
    await connection.close();
  }
  assert.equal(disposals, 1);
});
test("a bridge ignoring abort still cannot hold verification open", async () => {
  const abort = new AbortController();
  const work = bounded(new Promise<void>(() => {}), abort.signal);
  abort.abort();
  await assert.rejects(work, (error) => error instanceof Error && error.name === "AbortError");
});

for (const operation of ["ready", "adoption"] as const)
  test(`${operation} body parsing is bounded when response headers arrive but its body stalls`, async () => {
    const abort = new AbortController();
    let disposed = false,
      parsed = false;
    const connection = await openDeploymentReadiness({
      worker: "fixture-worker",
      accountId: "d".repeat(32),
      key,
      target,
      connect: async () => ({
        env: {
          POOL_OPERATIONS: {
            async fetch() {
              const response = new Response();
              Object.defineProperty(response, "json", {
                value: () => {
                  parsed = true;
                  abort.abort();
                  return new Promise(() => {});
                },
              });
              return response;
            },
          },
        },
        async dispose() {
          disposed = true;
        },
      }),
    });
    try {
      await assert.rejects(
        connection[operation](abort.signal),
        (error) => error instanceof Error && error.name === "AbortError",
      );
      assert.equal(parsed, true, "headers must complete before body parsing is aborted");
    } finally {
      await connection.close();
    }
    assert.equal(disposed, true);
  });

for (const status of [401, 409])
  test(`code adoption preserves the terminal HTTP ${status} refusal`, async () => {
    let requests = 0;
    const connection = await openDeploymentReadiness({
      worker: "fixture-worker",
      accountId: "d".repeat(32),
      key,
      target,
      connect: async () => ({
        env: {
          POOL_OPERATIONS: {
            async fetch() {
              requests++;
              return new Response(null, { status });
            },
          },
        },
        dispose: async () => {},
      }),
    });
    try {
      await assert.rejects(
        connection.adoption(new AbortController().signal),
        (error: unknown) => error instanceof Error && "status" in error && error.status === status,
      );
      assert.equal(requests, 1);
    } finally {
      await connection.close();
    }
  });

test("an already-aborted bound still handles a rejection from work that triggered abort", async () => {
  const abort = new AbortController();
  const work = (async () => {
    abort.abort();
    throw new Error("private rejected work");
  })();
  await assert.rejects(bounded(work, abort.signal), { name: "AbortError" });
});
