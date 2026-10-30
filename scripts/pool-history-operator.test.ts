import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { historyOperatorOptions, runHistoryOperator } from "./pool-history-operator.ts";

const account = "a".repeat(32);
const report = { status: "dry-run", version: "model_request_history_v1", schemaHash: "b".repeat(64),
  catalogHash: "c".repeat(64), writes: false, automaticBackfill: false };

test("operator plans bind the target and a lost apply response cannot issue another write", async () => {
  const directory = await mkdtemp(join(tmpdir(), "history-operator-fixture-"));
  try {
    const path = join(directory, "plan.json");
    const options = historyOperatorOptions(["--worker", "fixture-pool", "--plan", path]);
    let writes = 0;
    const connect = async (_path: string) => ({ env: { POOL_OPERATIONS: { fetch: async (request: Request) => {
      if (request.method === "GET") return Response.json(report);
      writes++;
      throw new Error("Response lost after accepting the write");
    } } }, dispose: async () => {} });
    await runHistoryOperator(options, account, connect);
    assert.equal(writes, 0);
    assert.equal(JSON.parse(await readFile(path, "utf8")).worker, options.worker);
    assert.throws(() => historyOperatorOptions(["--worker", "fixture-pool", "--plan", path, "--apply"]));
    const applying = historyOperatorOptions(["--worker", "fixture-pool", "--plan", path, "--apply", "--go"]);
    await assert.rejects(runHistoryOperator({ ...applying, worker: "another-pool" }, account, connect));
    await assert.rejects(runHistoryOperator({ ...applying, operation: "backfill" }, account, connect));
    assert.equal(writes, 0);
    await assert.rejects(runHistoryOperator(applying, account, connect));
    assert.equal(writes, 1);
    assert.equal(JSON.parse(await readFile(`${path}.result.json`, "utf8")).status, "started");
    await assert.rejects(runHistoryOperator(applying, account, connect));
    assert.equal(writes, 1, "a started receipt blocks an unchanged apply after an uncertain outcome");
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("backfill has its own dry run and requires both apply and go", async () => {
  const directory = await mkdtemp(join(tmpdir(), "history-backfill-fixture-"));
  try {
    const path = join(directory, "backfill.json");
    const args = ["--worker", "fixture-pool", "--plan", path, "--operation", "backfill"];
    const plan = { status: "dry-run", version: "model_request_backfill_v1", digest: "d".repeat(64),
      plan: { rows: "2", upperId: "2", privacyReady: true }, writes: false };
    const calls: Request[] = [];
    const connect = async (_path: string) => ({ env: { POOL_OPERATIONS: { fetch: async (request: Request) => {
      calls.push(request.clone());
      return Response.json(request.method === "GET" ? plan : { status: "complete", digest: plan.digest, activated: true });
    } } }, dispose: async () => {} });
    await runHistoryOperator(historyOperatorOptions(args), account, connect);
    assert.equal(calls.length, 1);
    assert.equal(calls[0]!.method, "GET");
    assert.equal(new URL(calls[0]!.url).pathname, "/model-history/backfill");
    assert.throws(() => historyOperatorOptions([...args, "--apply"]));
    assert.throws(() => historyOperatorOptions([...args, "--go"]));
    await runHistoryOperator(historyOperatorOptions([...args, "--apply", "--go"]), account, connect);
    assert.equal(calls.length, 2);
    assert.equal(calls[1]!.method, "POST");
    assert.deepEqual(await calls[1]!.json(), { digest: plan.digest, plan: plan.plan, go: true });
  } finally { await rm(directory, { recursive: true, force: true }); }
});
