import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:net";
import test from "node:test";

const run = (env) => spawnSync(process.execPath, ["scripts/scale-test/run.mjs"], {
  encoding: "utf8", env: { PATH: process.env.PATH, GITHUB_ACTIONS: "true", GITHUB_REF: "refs/heads/main", SCALE_STAGE: "scale-180", SCALE_MODE: "validate", ...env },
});
test("CI refuses production, unsupported stages, branches and local invocation before credentials", () => {
  assert.equal(run({}).status, 0);
  for (const env of [
    { SCALE_STAGE: "production" }, { SCALE_STAGE: "test-pr-180" }, { SCALE_STAGE: "" },
    { SCALE_MODE: "unknown" }, { GITHUB_REF: "refs/heads/other" }, { GITHUB_ACTIONS: "false" },
  ]) {
    const result = run(env);
    assert.notEqual(result.status, 0);
    assert.doesNotMatch(result.stderr, /Missing Cloudflare credential/);
  }
});
test("synthetic mock completes Chat, Responses and Messages SSE through HTTP", async (t) => {
  const reservation = createServer(); reservation.listen(0, "127.0.0.1"); await once(reservation, "listening");
  const port = reservation.address().port; await new Promise((resolve) => reservation.close(resolve));
  const child = spawn("python3", ["scripts/scale-test/mock.py"], {
    env: { PATH: process.env.PATH, SCALE_BIND: "127.0.0.1", SCALE_PORT: String(port), SCALE_DEADLINE: String(Date.now() / 1000 + 30) },
    stdio: ["ignore", "pipe", "pipe"],
  });
  t.after(async () => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    const exited = once(child, "exit"); child.kill("SIGTERM"); await exited;
  });
  await new Promise((resolve, reject) => {
    child.stdout.on("data", (data) => { if (data.toString().includes("READY")) resolve(); });
    child.once("error", reject); child.once("exit", (code) => reject(new Error(`Mock exited ${code}`)));
  });
  const origin = `http://127.0.0.1:${port}`;
  const settings = { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ duration: 0.01, rate: 50 }) };
  assert.equal((await fetch(`${origin}/settings`, settings)).status, 200);
  for (const [path, terminal] of [["chat/completions", "[DONE]"], ["responses", "response.completed"], ["messages", "message_stop"]]) {
    const response = await fetch(`${origin}/v1/${path}`, { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "synthetic", stream: true, metadata: {} }) });
    assert.equal(response.status, 200); assert.match(response.headers.get("content-type"), /event-stream/);
    assert.ok((await response.text()).includes(terminal));
  }
  const state = await (await fetch(`${origin}/stats`)).json();
  assert.equal(state.requests, 3); assert.equal(state.completed, 3); assert.equal(state.errors, 0);
});

test("expiry reclaims partial resources without a Worker and publishes only names and counts", async () => {
  const { mkdtempSync, readFileSync, readdirSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const directory = mkdtempSync(join(tmpdir(), "scale-cleanup-"));
  const calls = join(directory, "calls.jsonl");
  const result = spawnSync(process.execPath, ["--import", "./e2e/scale-provider-fixture.mjs", "scripts/scale-test/run.mjs"], {
    encoding: "utf8", env: { PATH: process.env.PATH, GITHUB_ACTIONS: "true", GITHUB_REF: "refs/heads/main",
      SCALE_STAGE: "scale-180", SCALE_MODE: "destroy", SCALE_EXPECT_DEADLINE: "123", SCALE_OUTPUT: join(directory, "results"),
      SCALE_FIXTURE_CALLS: calls, CLOUDFLARE_ACCOUNT_ID: "fixture-account", CLOUDFLARE_API_TOKEN: "fixture-token",
      PLANETSCALE_ORGANIZATION: "fixture-org", PLANETSCALE_API_TOKEN_ID: "fixture-id", PLANETSCALE_API_TOKEN: "fixture-token" },
  });
  assert.equal(result.status, 0, result.stderr);
  const operations = readFileSync(calls, "utf8").trim().split("\n").map(JSON.parse);
  assert.ok(operations.some((row) => row.method === "DELETE" && row.host === "api.planetscale.com"));
  assert.ok(operations.some((row) => row.method === "DELETE" && row.path.endsWith("/fixture-app")));
  assert.ok(!operations.some((row) => row.method === "DELETE" && row.path.includes("foreign-app")));
  const artifacts = readdirSync(join(directory, "results")).map((name) => readFileSync(join(directory, "results", name), "utf8")).join("");
  assert.doesNotMatch(artifacts, /private-|fixture-account|fixture-token|fixture-app|fixture-drive|fixture-ca/);
  const receipt = JSON.parse(readFileSync(join(directory, "results", "teardown.json")));
  assert.ok(Object.values(receipt.resources).every((resource) => resource.count === 0));
});

test("an older expiry leaves a newer Worker lease untouched", async () => {
  const { mkdtempSync, readFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const directory = mkdtempSync(join(tmpdir(), "scale-newer-lease-"));
  const calls = join(directory, "calls.jsonl");
  const result = spawnSync(process.execPath, ["--import", "./e2e/scale-provider-fixture.mjs", "scripts/scale-test/run.mjs"], {
    encoding: "utf8", env: { PATH: process.env.PATH, GITHUB_ACTIONS: "true", GITHUB_REF: "refs/heads/main",
      SCALE_STAGE: "scale-180", SCALE_MODE: "destroy", SCALE_EXPECT_DEADLINE: "123", SCALE_OUTPUT: join(directory, "results"),
      SCALE_FIXTURE_NEWER_LEASE: "true", SCALE_FIXTURE_CALLS: calls, CLOUDFLARE_API_TOKEN: "fixture-token" },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.ok(!readFileSync(calls, "utf8").includes('"method":"DELETE"'));
  assert.equal(JSON.parse(readFileSync(join(directory, "results", "expiry-skipped.json"))).reason, "A different lease owns the stage");
});

test("a delayed run leaves all sizes unmeasured and starts no traffic or resize", async () => {
  const { mkdtempSync, readFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const directory = mkdtempSync(join(tmpdir(), "scale-budget-"));
  const calls = join(directory, "calls.jsonl");
  const result = spawnSync(process.execPath, ["--import", "./e2e/scale-provider-fixture.mjs", "scripts/scale-test/run.mjs"], {
    encoding: "utf8", env: { PATH: process.env.PATH, GITHUB_ACTIONS: "true", GITHUB_REF: "refs/heads/main",
      SCALE_STAGE: "scale-180", SCALE_MODE: "run", SCALE_JOB_STARTED_AT: String(Date.now() - 65 * 60_000),
      SCALE_FIXTURE_RUN: "true", SCALE_FIXTURE_CALLS: calls, SCALE_OUTPUT: join(directory, "results"), CLOUDFLARE_API_TOKEN: "fixture-token" },
  });
  assert.equal(result.status, 0, result.stderr);
  const operations = readFileSync(calls, "utf8").trim().split("\n").map(JSON.parse);
  assert.equal(operations.length, 1);
  assert.equal(operations[0].method, "GET");
  const stopped = JSON.parse(readFileSync(join(directory, "results", "size-budget-stop.json")));
  assert.deepEqual(stopped.unmeasuredSizes, ["lite", "basic", "standard-2"]);
  assert.ok(stopped.remainingMs <= 5 * 60_000);
});
