import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { RuntimeRecovery, handleRuntimeRecovery } from "../src/pool/runtime-recovery.ts";
import { runPoolRuntimeOperator, runtimeOperatorOptions } from "./pool-runtime-operator.ts";

test("the operator saves its exact target and a lost reply becomes read-only receipt inspection", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pool-runtime-proof-"));
  const secret = "ab".repeat(32), accountId = "a".repeat(32);
  const options = { worker: "synthetic-pool-worker", plan: join(directory, "private-plan.json"), restart: false };
  const values = new Map<string, unknown>();
  let restarts = 0, posts = 0, disposals = 0;
  let temporaryConfig = "";
  const runtime = new RuntimeRecovery({ instanceId: "b".repeat(64), imageHash: "synthetic-image",
    running: () => true, status: async () => { throw new Error("not ready"); },
    restart: async () => { restarts++; return { boot_id: "replacement", started_at: "2026-11-04T00:00:00Z" }; },
  }, { get: async <T>(key: string) => structuredClone(values.get(key)) as T | undefined,
    put: async (key, value) => { values.set(key, structuredClone(value)); } });
  const service = { inspectRuntimeRecovery: (id?: string) => runtime.inspect(id), recoverRuntime: runtime.run.bind(runtime) };
  const connect = async (path: string) => {
    temporaryConfig = path;
    const config = JSON.parse(await readFile(path, "utf8"));
    assert.deepEqual(config.services, [{ binding: "POOL_OPERATIONS", service: options.worker, entrypoint: "PoolOperations", remote: true }]);
    return { dispose: async () => { disposals++; }, env: { POOL_OPERATIONS: { fetch: async (request: Request) => {
      const response = await handleRuntimeRecovery(request, service, secret);
      if (request.method === "POST") { posts++; assert.equal(response.status, 200); throw new Error("synthetic lost response"); }
      return response;
    } } } };
  };
  try {
    const plan = await runPoolRuntimeOperator(options, accountId, undefined, connect);
    assert.equal((plan as { status: string }).status, "dry-run");
    assert.equal(restarts, 0);
    assert.equal((await stat(options.plan)).mode & 0o777, 0o600);
    const approved = { ...options, restart: true };
    await assert.rejects(runPoolRuntimeOperator(approved, accountId, secret, connect), /synthetic lost response/);
    assert.equal(restarts, 1);
    const result = await runPoolRuntimeOperator(approved, accountId, secret, connect);
    assert.equal((result as { status: string }).status, "inspection");
    assert.match(JSON.stringify(result), /"status":"ready"/);
    assert.equal(restarts, 1);
    assert.equal(posts, 1);
    assert.equal(disposals, 3);
    await assert.rejects(stat(temporaryConfig), { code: "ENOENT" });
    await assert.rejects(runPoolRuntimeOperator({ ...approved, worker: "other-worker" }, accountId, secret, connect), /Plan target changed/);
    assert.equal(restarts, 1);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("the operator requires both explicit restart flags", () => {
  assert.throws(() => runtimeOperatorOptions(["--worker", "pool", "--plan", "private", "--restart"]));
  assert.deepEqual(runtimeOperatorOptions(["--worker", "pool", "--plan", "private", "--restart", "--go"]),
    { worker: "pool", plan: "private", restart: true });
});
