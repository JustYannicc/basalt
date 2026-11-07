import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const scripts = fileURLToPath(new URL("./", import.meta.url));
const target = {
  candidate: "a".repeat(40),
  workerInput: "b".repeat(64),
  imageHash: "1234abcd",
};
const ready = {
  ...target,
  desiredRevisionMatch: true,
  instanceId: "c".repeat(64),
  bootId: "fixture-boot",
  readyAt: Date.now(),
};

function fixture(directory: string) {
  const bridge = join(directory, "bridge.mjs"),
    driver = join(directory, "driver.mjs");
  writeFileSync(
    bridge,
    `
    import {createServer} from "node:http";
    import {stalled} from "./scheduler.mjs";
    export async function getPlatformProxy() {
      if (process.env.FIXTURE_CASE === "opening") return stalled("command");
      let server, origin;
      if (["unready", "unreachable", "close-after-failure"].includes(process.env.FIXTURE_CASE)) {
        server = createServer((_request, response) => response.writeHead(503).end());
        await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
        origin = "http://127.0.0.1:" + server.address().port;
        if (process.env.FIXTURE_CASE === "unreachable") {
          await new Promise(resolve => server.close(resolve));
          server = undefined;
        }
      }
      return {
        env: { POOL_OPERATIONS: { async fetch() {
          if (process.env.FIXTURE_CASE === "readiness") return stalled("command");
          if (["unready", "close-after-failure"].includes(process.env.FIXTURE_CASE))
            return globalThis.fetch(origin);
          if (process.env.FIXTURE_CASE === "unreachable")
            return globalThis.fetch(origin);
          const response = Response.json(${JSON.stringify(ready)});
          if (process.env.FIXTURE_CASE === "body")
            Object.defineProperty(response, "json", {value: () => stalled("command")});
          return response;
        } } },
        async dispose() {
          if (server) {
            server.closeAllConnections();
            await new Promise(resolve => server.close(resolve));
          }
          if (["close", "close-after-failure"].includes(process.env.FIXTURE_CASE)) {
            setInterval(() => {}, 10000);
            return stalled("teardown");
          }
        },
      };
    }
  `,
  );
  writeFileSync(
    driver,
    `
    import {stalled} from "./scheduler.mjs";
    export default { Client: class {
      connection = {stream: {destroy() {}}};
      on() {}
      async connect() {
        if (process.env.FIXTURE_CASE === "connect") return stalled("command");
      }
      async end() {}
      async query(sql) {
        if (sql.includes("AS visible")) return {rows: [{visible: true}]};
        if (sql.includes("pg_stat_activity")) return {rows: [{database: "pool", connections: 5}]};
        return {rows: []};
      }
    } };
  `,
  );
  writeFileSync(
    join(directory, "scheduler.mjs"),
    `
    const pending = new Map();
    export function deadline(milliseconds, phase) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), milliseconds);
      pending.set(controller, phase);
      return {signal: controller.signal, dispose() {
        clearTimeout(timer);
        pending.delete(controller);
      }};
    }
    export function stalled(phase) {
      // Expire only once the fixture has entered the operation that will never finish.
      // Deferring also lets the caller register the teardown deadline after close() starts.
      queueMicrotask(() => {
        for (const [controller, kind] of pending) if (kind === phase) controller.abort();
      });
      return new Promise(() => {});
    }
  `,
  );
  writeFileSync(
    join(directory, "command.mjs"),
    `
    import {runDatabaseBudgetCommand as run} from ${JSON.stringify(new URL("./database-budget-command.ts", import.meta.url).href)};
    import {deadline} from "./scheduler.mjs";
    export const runDatabaseBudgetCommand = (source, args) => run(source, args, {deadline});
  `,
  );
  writeFileSync(
    join(directory, "receipt.mjs"),
    `
    export {mkdir, readFile} from "node:fs/promises";
    import {writeFile as write} from "node:fs/promises";
    import {stalled} from "./scheduler.mjs";
    let first = true;
    export async function writeFile(...args) {
      await write(...args);
      if (first) { first = false; return stalled("receipt"); }
    }
  `,
  );
  const preload = join(directory, "preload.mjs");
  writeFileSync(
    preload,
    `
    import { registerHooks } from "node:module";
    import { pathToFileURL } from "node:url";
    registerHooks({resolve(specifier, context, next) {
      if (process.env.FIXTURE_CASE === "receipt" && specifier === "node:fs/promises" && context.parentURL === ${JSON.stringify(new URL("./database-budget-command.ts", import.meta.url).href)})
        return {url: pathToFileURL(${JSON.stringify(join(directory, "receipt.mjs"))}).href, shortCircuit: true};
      if (specifier === "./database-budget-command.ts") return {url: pathToFileURL(${JSON.stringify(join(directory, "command.mjs"))}).href, shortCircuit: true};
      if (specifier === "wrangler") return {url: pathToFileURL(${JSON.stringify(bridge)}).href, shortCircuit: true};
      if (specifier === "pg") return {url: pathToFileURL(${JSON.stringify(driver)}).href, shortCircuit: true};
      return next(specifier, context);
    }});
  `,
  );
  return preload;
}

for (const [scenario, mode, outcome] of [
  ["unready", "ready", "readiness-error"],
  ["unreachable", "verify", "readiness-error"],
  ["opening", "ready", "abort"],
  ["readiness", "ready", "abort"],
  ["body", "ready", "abort"],
  ["receipt", "ready", "abort"],
  ["connect", "verify", "abort"],
  ["close", "ready", "teardown-error"],
  ["close-after-failure", "ready", "readiness-error"],
  ["success", "ready", "converged"],
  ["success", "verify", "converged"],
] as const) {
  test(`real budget CLI ${mode}: ${scenario} exits with a receipt inside its bound`, () => {
    const directory = mkdtempSync(join(tmpdir(), "budget-cli-"));
    try {
      const path = join(directory, "receipt.json"),
        prior = join(directory, "ready.json");
      writeFileSync(
        prior,
        JSON.stringify({ startedAt: Date.now(), readyReceivedAt: Date.now(), ready }),
      );
      const result = spawnSync(
        process.execPath,
        [
          "--import",
          fixture(directory),
          "verify-database-budget.ts",
          ...(mode === "ready" ? ["--ready"] : []),
        ],
        {
          cwd: scripts,
          encoding: "utf8",
          timeout: 5000,
          // No inherited credentials or production connection can reach this process.
          env: {
            FIXTURE_CASE: scenario,
            GITHUB_SHA: target.candidate,
            DATABASE_BUDGET_WORKER_INPUT: target.workerInput,
            DATABASE_BUDGET_IMAGE_HASH: target.imageHash,
            DATABASE_BUDGET_WORKER: "fixture-worker",
            CLOUDFLARE_ACCOUNT_ID: "fixture-account",
            POOL_DEPLOYMENT_KEY: "d".repeat(64),
            DATABASE_BUDGET_RECEIPT: path,
            DATABASE_BUDGET_READY_RECEIPT: prior,
            DATABASE_BUDGET_ADMIN_URL:
              "postgresql://fixture:fixture@127.0.0.1:1/pool?sslmode=disable",
            DATABASE_BUDGET_RUNTIME_LOGINS: '["runtime"]',
            DATABASE_BUDGET_DATABASES: '["pool"]',
          },
        },
      );
      assert.equal(result.error, undefined);
      assert.equal(result.signal, null);
      assert.equal(result.status, outcome === "converged" ? 0 : 1, result.stderr);
      assert.doesNotMatch(result.stderr, /unsettled top-level await/);
      const output = JSON.parse(outcome === "converged" ? result.stdout : result.stderr);
      assert.equal(output.outcome, outcome);
      if (scenario === "close") assert.equal(output.stage, "teardown");
      if (scenario === "close-after-failure") assert.equal(output.stage, "readiness");
      assert.equal(output.commandDeadlineMs, mode === "ready" ? 180000 : 115000);
      assert.deepEqual(output.target, target);
      const retained = JSON.parse(readFileSync(path, "utf8"));
      if (mode === "ready" && outcome === "converged") assert.deepEqual(retained.ready, ready);
      else {
        assert.ok(retained.elapsedMs <= output.elapsedMs);
        assert.deepEqual({ ...retained, elapsedMs: output.elapsedMs }, output);
      }
      assert.doesNotMatch(result.stdout + result.stderr, /fixture-only|private-host|postgresql:/);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
}

test("the real CLI reports an unreachable local PostgreSQL connection without adapter mocks", () => {
  const directory = mkdtempSync(join(tmpdir(), "budget-cli-postgres-"));
  try {
    const path = join(directory, "receipt.json");
    const result = spawnSync(process.execPath, ["verify-database-budget.ts"], {
      cwd: scripts,
      encoding: "utf8",
      timeout: 10000,
      env: {
        DATABASE_BUDGET_ADMIN_URL: "postgresql://fixture:fixture@127.0.0.1:1/pool?sslmode=disable",
        DATABASE_BUDGET_RUNTIME_LOGINS: '["runtime"]',
        DATABASE_BUDGET_DATABASES: '["pool"]',
        DATABASE_BUDGET_RECEIPT: path,
      },
    });
    assert.equal(result.error, undefined);
    assert.equal(result.status, 1, result.stderr);
    const receipt = JSON.parse(readFileSync(path, "utf8"));
    assert.equal(receipt.outcome, "connect-error");
    assert.equal(receipt.code, "ECONNREFUSED");
    assert.deepEqual(JSON.parse(result.stderr), receipt);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("an unwritable receipt destination still exits nonzero with the safe failure receipt", () => {
  const directory = mkdtempSync(join(tmpdir(), "budget-cli-receipt-"));
  try {
    const blocked = join(directory, "blocked");
    writeFileSync(blocked, "not a directory");
    const result = spawnSync(process.execPath, ["verify-database-budget.ts", "--ready"], {
      cwd: scripts,
      encoding: "utf8",
      timeout: 5000,
      env: { DATABASE_BUDGET_RECEIPT: join(blocked, "receipt.json"), GITHUB_SHA: target.candidate },
    });
    assert.equal(result.error, undefined);
    assert.equal(result.status, 1, result.stderr);
    const receipt = JSON.parse(result.stderr);
    assert.equal(receipt.outcome, "readiness-error");
    assert.equal(receipt.candidate, target.candidate);
    assert.equal(receipt.stage, "readiness");
    assert.doesNotMatch(result.stderr, /blocked|ENOTDIR/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("the default deadline keeps a stalled operation alive until it aborts", () => {
  const result = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "--eval",
      `
    import {bounded, liveDeadline} from ${JSON.stringify(new URL("./database-budget-readiness.ts", import.meta.url).href)};
    const deadline = liveDeadline(1);
    try { await bounded(new Promise(() => {}), deadline.signal); }
    catch (error) { console.log(error.name); }
    finally { deadline.dispose(); }
  `,
    ],
    { encoding: "utf8", timeout: 5000, env: {} },
  );
  assert.equal(result.error, undefined);
  assert.equal(result.signal, null);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), "AbortError");
  assert.doesNotMatch(result.stderr, /unsettled top-level await/);
});
