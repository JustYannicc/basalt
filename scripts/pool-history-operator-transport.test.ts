import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "node:test";
import { runHistoryOperator } from "./pool-history-operator.ts";
import { nodePoolOperations } from "./pool-operations-node.ts";
import { historyJournalActivationManifest } from "../src/pool/model-history/operator.ts";
import { historyPlan } from "./release-barrier/migration-activation-commands.ts";
import { migrationActivationIntent } from "./release-barrier/migration-activation.ts";
import { releaseOperationFingerprint } from "./release-barrier/release-operation.ts";

const account = "a".repeat(32);
const worker = "fixture-pool";
const version = "model_request_history_v10_change_journal_activate";
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const catalog = {
  relations: [{ name: "basalt_model_history_migrations", kind: "r" }],
  journalPrepared: true,
  journalActivated: false,
};
const report = {
  status: "dry-run",
  version,
  schemaHash: hash(historyJournalActivationManifest),
  catalogHash: hash(catalog),
  catalog,
  applied: false,
  catalogDiff: { createTables: [], conflicts: [] },
  pendingMigrations: [version],
  readersReadyRequired: "checkpoint-count-v1",
  writes: false,
  automaticBackfill: false,
};

async function fixture(directory: string, body: unknown = report) {
  const peer = join(directory, "node-peer.mjs");
  const observed = join(directory, "observed.json");
  const closed = join(directory, "closed");
  const wrangler = new URL("./startup-profiler/package.json", import.meta.url).href;
  // Keep the real pinned dependency and IPC transport; replace only the remote service response.
  await writeFile(
    peer,
    `import { createRequire } from "node:module";
import { writeFileSync } from "node:fs";
const require = createRequire(${JSON.stringify(wrangler)});
const wrangler = require("wrangler");
if (process.versions.bun || typeof wrangler.getPlatformProxy !== "function") process.exit(1);
process.on("message", (message) => {
  if (message.kind === "open") process.send({kind:"ready"});
  if (message.kind === "request") {
    writeFileSync(${JSON.stringify(observed)}, JSON.stringify({
      node: !process.versions.bun, method: message.method, url: message.url,
      body: message.body ?? null, wrangler: require("wrangler/package.json").version,
    }));
    process.send({kind:"result", id:message.id, status:200,
      headers:[["content-type","application/json"]],
      body:Buffer.from(${JSON.stringify(JSON.stringify(body))}).toString("base64")});
  }
  if (message.kind === "close") {
    writeFileSync(${JSON.stringify(closed)}, "closed");
    process.send({kind:"closed"});
  }
});
`,
  );
  return {
    observed,
    closed,
    connect: (accountId: string, target: string) =>
      nodePoolOperations(accountId, target, pathToFileURL(peer)),
  };
}

test("Bun's default history connection reaches the catalog through the Node bridge", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "history-bun-proxy-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  if (!process.versions.bun) {
    const result = spawnSync(
      "bun",
      [
        "test",
        "--test-name-pattern",
        "Bun's default history connection reaches the catalog through the Node bridge",
        import.meta.filename,
      ],
      {
        env: { PATH: process.env.PATH, HOME: directory, CI: "1", WRANGLER_SEND_METRICS: "false" },
        encoding: "utf8",
      },
    );
    assert.equal(result.status, 0, result.stdout + result.stderr);
    return;
  }
  const bridge = await fixture(directory);
  const result = await runHistoryOperator(
    {
      worker,
      plan: join(directory, "plan.json"),
      operation: "journal-activation",
      apply: false,
      readersReady: undefined,
    },
    account,
    undefined,
    bridge.connect,
  );
  assert.equal(result.schemaHash, report.schemaHash);
  assert.deepEqual(JSON.parse(await readFile(bridge.observed, "utf8")), {
    node: true,
    method: "GET",
    url: "http://pool-operations/model-history/journal-activation",
    body: null,
    wrangler: "4.153.0",
  });
  assert.equal(await readFile(bridge.closed, "utf8"), "closed");
});

test("Node transport preserves the activation report, saved plan and final fingerprint", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "history-transport-digest-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const bridge = await fixture(directory);
  const options = {
    worker,
    operation: "journal-activation",
    apply: false,
    readersReady: undefined,
  } as const;
  const directPath = join(directory, "direct.json");
  const nodePath = join(directory, "node.json");
  const direct = async () => ({
    env: { POOL_OPERATIONS: { fetch: async () => Response.json(report) } },
    dispose: async () => {},
  });
  const remote = () => bridge.connect(account, worker);
  assert.deepEqual(
    await runHistoryOperator({ ...options, plan: nodePath }, account, remote),
    await runHistoryOperator({ ...options, plan: directPath }, account, direct),
  );
  assert.deepEqual(
    JSON.parse(await readFile(nodePath, "utf8")),
    JSON.parse(await readFile(directPath, "utf8")),
  );
  const inProcess = await historyPlan(
    (input, id) => runHistoryOperator({ ...input, readersReady: input.readersReady }, id, direct),
    account,
    worker,
  );
  const overIpc = await historyPlan(
    (input, id) => runHistoryOperator({ ...input, readersReady: input.readersReady }, id, remote),
    account,
    worker,
  );
  assert.deepEqual(overIpc, inProcess);
  const candidate = "a".repeat(40);
  const fingerprint = (pool: typeof inProcess) =>
    releaseOperationFingerprint(
      candidate,
      migrationActivationIntent(candidate, {
        candidate,
        sourceFingerprint: "b".repeat(64),
        readers: {
          release: { candidate, deploymentId: 42, receiptDigest: "b".repeat(64) },
          workers: (["Api", "AppPages", "PoolWorker"] as const).map((role) => ({
            role,
            target: "b".repeat(64),
            versionId: role,
            acceptedVersionId: role,
            percentage: 100,
          })),
          poolAdoption: {
            candidate,
            poolWorkerRevision: "b".repeat(64),
            imageInput: "526fa60bed0df442",
          },
          apps: { count: 4, fingerprint: "b".repeat(64) },
        },
        hosted: { prepared: true, active: false, fingerprint: "b".repeat(64) },
        pool,
      }),
    );
  assert.equal(fingerprint(overIpc), fingerprint(inProcess));
  assert.equal(await readFile(bridge.closed, "utf8"), "closed");
});

test("the Node history connection closes when the catalog is invalid", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "history-transport-refusal-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const bridge = await fixture(directory, { ...report, schemaHash: "invalid" });
  await assert.rejects(
    runHistoryOperator(
      {
        worker,
        plan: join(directory, "plan.json"),
        operation: "journal-activation",
        apply: false,
        readersReady: undefined,
      },
      account,
      () => bridge.connect(account, worker),
    ),
  );
  assert.equal(await readFile(bridge.closed, "utf8"), "closed");
});
