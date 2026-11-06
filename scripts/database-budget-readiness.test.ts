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

test("readiness body parsing is bounded when response headers arrive but its body stalls", async () => {
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
      connection.ready(abort.signal),
      (error) => error instanceof Error && error.name === "AbortError",
    );
    assert.equal(parsed, true, "headers must complete before body parsing is aborted");
  } finally {
    await connection.close();
  }
  assert.equal(disposed, true);
});
