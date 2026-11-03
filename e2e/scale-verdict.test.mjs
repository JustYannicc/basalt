import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const directory = () => mkdtempSync(join(tmpdir(), "scale-verdict-"));
const save = (dir, name, value) => writeFileSync(join(dir, `${name}.json`), JSON.stringify(value));
function verdict(dir, mode = "run") {
  const result = spawnSync(process.execPath, ["scripts/scale-test/verdict.mjs"], {
    encoding: "utf8", env: { ...process.env, SCALE_OUTPUT: dir, SCALE_MODE: mode },
  });
  return { ...result, verdict: JSON.parse(readFileSync(join(dir, "verdict.json"))) };
}
function complete(dir) {
  save(dir, "candidate", { candidate: "f8213cfd9957fa7cf467c56035ce3dac96438b3c", imageDigest: "sha256:6a0432480ae39e91ac3f574f020805ce8c3a3e4786ded7b6c809a17be339ab7c" });
  save(dir, "teardown", { resources: { applications: { count: 0 }, namespaces: { count: 0 }, scripts: { count: 0 }, drives: { count: 0 }, certificates: { count: 0 }, database: { count: 0 } } });
  for (const size of ["lite", "basic", "standard-2"]) {
    const specs = [
      ...["chat", "responses", "messages"].map(protocol => ({ id: `${size}-${protocol}-probe`, protocol, users: 1, concurrency: 1, requests: 1, streamSeconds: 2, bodyBytes: 1024 })),
      ...[[1, 20], [200, 800], [200, 2000], [200, 4000], [5000, 5000]].map(([users, concurrency]) => ({ id: `${size}-${users}-${concurrency}`, users, concurrency, requests: concurrency, streamSeconds: 60, bodyBytes: 262144, startsPerSecond: 100 })),
      { id: `${size}-long`, users: 20, concurrency: 20, requests: 20, streamSeconds: 360, bodyBytes: 262144, rate: 1 },
    ];
    for (const spec of specs) {
      const record = { status: 200, terminal: true, error: null, ttfbMs: 5, firstContentMs: 10, durationMs: 100, bytes: 100, events: 2 };
      save(dir, spec.id, { spec, result: { state: "done", count: spec.requests, success: spec.requests, records: Array.from({ length: spec.requests }, (_, index) => ({ ...record, index, user: index % spec.users })), scheduleLagMsP99: 0 }, samples: [{ at: 1, pool: { sample: { memoryCurrent: "10", memoryMax: "100" } }, budget: { estimatedUpperUsd: 4.5 } }] });
      save(dir, `${spec.id}-persistence`, { expected: spec.requests, before: { usage: [{ records: 0 }] }, after: { usage: [{ records: spec.requests }] } });
    }
  }
}
test("deploy and destroy cannot pass the capacity gate, even beside load files", () => {
  const dir = directory(); complete(dir);
  for (const mode of ["deploy", "destroy"]) {
    const result = verdict(dir, mode);
    assert.notEqual(result.status, 0);
    assert.equal(result.verdict.status, "not_measured");
    assert.equal(result.verdict.autoscalingProven, false);
  }
});
test("missing, partial, stopped and unsuccessful traffic fails the verdict", () => {
  const empty = verdict(directory()); assert.notEqual(empty.status, 0);
  assert.equal(empty.verdict.status, "incomplete");
  for (const defect of ["missing", "capacity-stop", "no-records", "http-error", "no-latency", "no-samples", "no-persistence", "no-teardown", "unknown-memory"]) {
    const dir = directory(); complete(dir);
    const name = "lite-5000-5000";
    const data = JSON.parse(readFileSync(join(dir, `${name}.json`)));
    if (defect === "missing") data.result.state = "running";
    if (defect === "capacity-stop") save(dir, "lite-capacity-stop", { message: "stopped" });
    if (defect === "no-records") data.result.records = [];
    if (defect === "http-error") data.result.records[0].status = 500;
    if (defect === "no-latency") data.result.records[0].firstContentMs = null;
    if (defect === "no-samples") data.samples = [];
    if (defect === "unknown-memory") data.samples[0].pool.sample.memoryMax = "max";
    if (defect === "no-persistence") save(dir, `${name}-persistence`, { expected: 1, after: { usage: [{ records: 0 }] } });
    if (defect === "no-teardown") save(dir, "teardown", { resources: {} });
    save(dir, name, data);
    assert.notEqual(verdict(dir).status, 0, defect);
  }
});
test("complete measured traffic yields scoped percentiles and counts, never autoscaling proof", () => {
  const dir = directory(); complete(dir);
  const result = verdict(dir);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.verdict.status, "passed");
  assert.equal(result.verdict.scope, "single_instance_pool");
  assert.equal(result.verdict.autoscalingProven, false);
  const tier = result.verdict.scenarios.find(s => s.id === "lite-5000-5000");
  assert.equal(tier.completed, 5000); assert.equal(tier.errorRate, 0);
  assert.deepEqual(tier.firstContentMs, { p50: 10, p95: 10, p99: 10 });
});
