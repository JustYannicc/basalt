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
    env: { PATH: process.env.PATH, SCALE_ADMIN: "fixture-control", SCALE_BIND: "127.0.0.1", SCALE_PORT: String(port), SCALE_DEADLINE: String(Date.now() / 1000 + 30) },
    stdio: ["ignore", "pipe", "pipe"],
  });
  t.after(async () => { child.kill("SIGTERM"); await once(child, "exit"); });
  await new Promise((resolve, reject) => {
    child.stdout.on("data", (data) => { if (data.toString().includes("READY")) resolve(); });
    child.once("error", reject); child.once("exit", (code) => reject(new Error(`Mock exited ${code}`)));
  });
  const origin = `http://127.0.0.1:${port}`;
  const settings = { method: "POST", headers: { "Content-Type": "application/json", "X-Scale-Admin": "fixture-control" }, body: JSON.stringify({ duration: 0.01, rate: 50 }) };
  assert.equal((await fetch(`${origin}/settings`, { ...settings, headers: {} })).status, 403);
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
