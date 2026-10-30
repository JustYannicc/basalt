import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { operatorOptions, runPoolWebSocketOperator } from "./pool-websocket-operator.ts";

const accountId = "0".repeat(32);
const selection = { total: 2, enabled: 1, pending: 1, writes: 2, limit: 50, digest: "a".repeat(64) };

async function fixture(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), "pool-operator-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const options = { worker: "fixture-pool", plan: join(directory, "private-plan.json"), apply: false };
  const requests: Request[] = [];
  let disposed = 0;
  let fail = false;
  const connect = async (configPath: string) => {
    const config = JSON.parse(await readFile(configPath, "utf8"));
    assert.deepEqual(config.services, [{ binding: "POOL_OPERATIONS", service: options.worker, entrypoint: "PoolOperations", remote: true }]);
    assert.equal(config.account_id, accountId);
    return {
      env: { POOL_OPERATIONS: { fetch: async (request: Request) => {
        requests.push(request);
        if (fail) throw new Error("fixture lost response");
        return Response.json({ ...selection, status: request.method === "GET" ? "dry-run" : "complete",
          applied: request.method === "GET" ? 0 : selection.writes });
      } } },
      dispose: async () => { disposed++; },
    };
  };
  return { options, requests, connect, disposed: () => disposed, fail: () => { fail = true; } };
}

test("the operator defaults to dry run and an apply requires explicit GO flags", () => {
  assert.equal(operatorOptions(["--worker", "fixture-pool", "--plan", "private.json"]).apply, false);
  assert.throws(() => operatorOptions(["--worker", "fixture-pool", "--plan", "private.json", "--apply"]));
  assert.throws(() => operatorOptions(["--worker", "fixture-pool", "--plan", "private.json", "--apply", "yes"]));
  assert.equal(operatorOptions(["--worker", "fixture-pool", "--plan", "private.json", "--apply", "--go"]).apply, true);
});

test("the operator reaches the named binding, saves a private target-bound dry run and applies it once", async (t) => {
  const f = await fixture(t);
  const result = await runPoolWebSocketOperator(f.options, accountId, f.connect);
  assert.equal(result.status, "dry-run");
  assert.equal(f.requests[0]!.method, "GET");
  assert.equal((await stat(f.options.plan)).mode & 0o777, 0o600);
  await assert.rejects(runPoolWebSocketOperator({ ...f.options, worker: "different-pool", apply: true }, accountId, f.connect));
  const applied = await runPoolWebSocketOperator({ ...f.options, apply: true }, accountId, f.connect);
  assert.equal(applied.applied, 2);
  assert.deepEqual(await f.requests[1]!.json(), { digest: selection.digest, pending: selection.pending });
  await assert.rejects(runPoolWebSocketOperator({ ...f.options, apply: true }, accountId, f.connect));
  assert.equal(f.requests.length, 2, "an existing apply receipt must prevent another request");
  assert.equal(f.disposed(), 3);
});

test("an uncertain apply keeps its started receipt and cannot be retried silently", async (t) => {
  const f = await fixture(t);
  await runPoolWebSocketOperator(f.options, accountId, f.connect);
  f.fail();
  await assert.rejects(runPoolWebSocketOperator({ ...f.options, apply: true }, accountId, f.connect));
  const receipt = JSON.parse(await readFile(`${f.options.plan}.result.json`, "utf8"));
  assert.equal(receipt.status, "started");
  await assert.rejects(runPoolWebSocketOperator({ ...f.options, apply: true }, accountId, f.connect));
  assert.equal(f.requests.length, 2);
});
