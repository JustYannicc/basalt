import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { candidate, imageDigest, sizes } from "./settings.ts";
import { scenarios } from "./scenarios.mjs";

const directory = process.env.SCALE_OUTPUT;
if (!directory) throw new Error("Missing private output directory");
mkdirSync(directory, { recursive: true, mode: 0o700 });
const read = name => { try { return JSON.parse(readFileSync(join(directory, `${name}.json`), "utf8")); } catch { return null; } };
const finite = value => Number.isFinite(value) && value >= 0;
// cgroup files are decimal text. Missing values and the unlimited "max" marker are not measurements.
const memoryBytes = value => typeof value === "string" && /^\d+$/.test(value) ? Number(value) : typeof value === "number" ? value : NaN;
const percentiles = values => Object.fromEntries([["p50", .5], ["p95", .95], ["p99", .99]].map(([name, p]) => {
  const sorted = [...values].sort((a, b) => a - b);
  return [name, sorted[Math.max(0, Math.ceil(sorted.length * p) - 1)]];
}));
const mode = process.env.SCALE_MODE;
const verdict = { mode, status: mode === "run" ? "incomplete" : "not_measured", scope: "single_instance_pool", autoscalingProven: false,
  candidate, imageDigest, missing: [], invalid: [], scenarios: [] };
if (mode === "run") {
  const identity = read("candidate");
  if (identity?.candidate !== candidate || identity?.imageDigest !== imageDigest) verdict.invalid.push("candidate");
  for (const size of sizes) {
    if (existsSync(join(directory, `${size}-capacity-stop.json`))) verdict.invalid.push(`${size}-capacity-stop`);
    for (const spec of scenarios(size)) {
      const data = read(spec.id);
      if (!data) { verdict.missing.push(spec.id); continue; }
      const { result, samples } = data;
      const records = result?.records;
      const matchingSpec = Object.entries(spec).every(([key, value]) => data.spec?.[key] === value);
      const measured = matchingSpec && result?.state === "done" && result.count === spec.requests && result.success === spec.requests
        && Array.isArray(records) && records.length === spec.requests
        && new Set(records.map(r => r.index)).size === spec.requests
        && records.every(r => Number.isInteger(r.index) && r.index >= 0 && r.index < spec.requests
          && r.user === r.index % spec.users && r.status === 200 && r.terminal === true && r.error === null
          && [r.ttfbMs, r.firstContentMs, r.durationMs].every(finite) && r.events > 0 && r.bytes > 0)
        && finite(result.scheduleLagMsP99) && result.scheduleLagMsP99 <= 1000
        && Array.isArray(samples) && samples.length > 0 && samples.every(s => finite(s.at)
          && finite(memoryBytes(s.pool?.sample?.memoryCurrent)) && finite(memoryBytes(s.pool?.sample?.memoryMax)) && memoryBytes(s.pool?.sample?.memoryMax) > 0
          && memoryBytes(s.pool.sample.memoryCurrent) / memoryBytes(s.pool.sample.memoryMax) < .8
          && finite(s.budget?.estimatedUpperUsd) && s.budget.estimatedUpperUsd < 7.5);
      const persisted = read(`${spec.id}-persistence`);
      const before = persisted?.before?.usage?.[0]?.records;
      const after = persisted?.after?.usage?.[0]?.records;
      if (!measured || !finite(before) || persisted?.expected !== before + spec.requests || !finite(after) || after < persisted.expected) {
        verdict.invalid.push(spec.id); continue;
      }
      verdict.scenarios.push({ id: spec.id, users: spec.users, targetConcurrency: spec.concurrency, completed: records.length, errorRate: 0,
        ttfbMs: percentiles(records.map(r => r.ttfbMs)), firstContentMs: percentiles(records.map(r => r.firstContentMs)),
        durationMs: percentiles(records.map(r => r.durationMs)) });
    }
  }
  const cleanup = read("teardown");
  if (!["applications", "namespaces", "scripts", "drives", "certificates", "database"].every(kind => cleanup?.resources?.[kind]?.count === 0)
    || (cleanup.cleanupErrors?.length ?? 0) > 0) verdict.invalid.push("teardown");
  for (const name of ["failure", "size-budget-stop"]) if (existsSync(join(directory, `${name}.json`))) verdict.invalid.push(name);
  if (!verdict.missing.length && !verdict.invalid.length) verdict.status = "passed";
}
writeFileSync(join(directory, "verdict.json"), JSON.stringify(verdict, null, 2) + "\n", { mode: 0o600 });
if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `status=${verdict.status}\n`);
if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY,
  `## Load evidence: ${verdict.status}\nMode: ${mode}. Scope: single-instance pool. Autoscaling proven: false.\nCompleted scenarios: ${verdict.scenarios.length}. Missing: ${verdict.missing.length}. Invalid: ${verdict.invalid.length}.\n`);
console.log(`Load evidence: ${verdict.status}; single-instance pool only; autoscaling unproven`);
process.exitCode = verdict.status === "passed" ? 0 : 1;
