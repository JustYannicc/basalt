import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { test } from "node:test";
import { heavyJobs } from "./ci/areas.ts";
import { conditionalJobs, fastJobs, gateErrors, longJobs, startJobs } from "./ci/gate.ts";

type Job = { needs?: string | string[]; if?: string } & Record<string, unknown>;
const { parse } = createRequire(new URL("./architecture/package.json", import.meta.url))("yaml");
const jobsOf = (text: string): Record<string, Job> => parse(text).jobs;
const jobs = jobsOf(readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8"));
const needsOf = (job: Job | undefined) => [job?.needs ?? []].flat();

// These decide for themselves whether to run, so the start order does not apply: `select` comes
// before it, `fast` and `fast-units` start beside `select`, `check` waits for everything, and
// `cpa-pipeline` also runs on a reused Check, where `long-started` is skipped.
const unordered = ["select", ...startJobs, "long-started", "cpa-pipeline", "check"];
const ordered = Object.keys(jobs).filter((id) => !unordered.includes(id));
const later = ordered.filter((id) => !longJobs.includes(id));

test("every job the selector starts is in the long tier or waits for it to start", () => {
  assert.deepEqual(
    later.filter((id) => !needsOf(jobs[id]).includes("long-started")),
    [],
    "outside the long tier but not waiting for long-started",
  );
  assert.deepEqual(
    longJobs.filter((id) => needsOf(jobs[id]).includes("long-started")),
    [],
    "in the long tier but waiting for long-started",
  );
  for (const id of ordered) {
    assert.ok(needsOf(jobs[id]).includes("select"), id);
    // Without a status function a job is skipped whenever a need did not succeed, so a failed
    // long-started can only skip work, which the gate then refuses.
    assert.doesNotMatch(
      jobs[id]!.if ?? "",
      /always\(\)|cancelled\(\)|failure\(\)|success\(\)|\.result\b/,
      id,
    );
  }
});

test("the long tier names real jobs once and the trivial job only orders the start", () => {
  assert.equal(new Set(longJobs).size, longJobs.length);
  for (const id of longJobs) assert.ok(ordered.includes(id), id);
  assert.deepEqual(jobs["long-started"], {
    needs: "select",
    // A reused Check skips it, and with it every job outside the long tier.
    if: "needs.select.outputs.reused != 'true'",
    permissions: {},
    "runs-on": "ubuntu-latest",
    "timeout-minutes": 2,
    steps: [{ run: "true" }],
  });
  for (const id of unordered.filter((id) => id !== "check"))
    assert.ok(!needsOf(jobs[id]).includes("long-started"), id);
  // select and the jobs that start beside it wait for nothing and run in every Check.
  for (const id of ["select", ...startJobs]) {
    assert.deepEqual(needsOf(jobs[id]), [], id);
    assert.equal(jobs[id]!.if, undefined, id);
    assert.ok(fastJobs.includes(id), id);
  }
  assert.deepEqual(
    [...needsOf(jobs.check)].sort(),
    Object.keys(jobs)
      .filter((id) => id !== "check")
      .sort(),
  );
});

test("a long-started that did not succeed fails the gate, with or without the jobs it skipped", () => {
  const expected = [...fastJobs, ...heavyJobs, ...conditionalJobs];
  const passed = Object.fromEntries(
    expected.map((id) => [
      id,
      { result: conditionalJobs.includes(id) && id !== "workerd-assets" ? "skipped" : "success" },
    ]),
  );
  assert.deepEqual(gateErrors(passed, heavyJobs, [], "full"), []);
  for (const result of ["failure", "cancelled", "skipped"]) {
    // What GitHub reports: the long tier ran, every job waiting for long-started was skipped.
    const skipped = Object.fromEntries(
      expected.map((id) => [
        id,
        later.includes(id) ? { result: "skipped" } : (passed[id] ?? { result: "missing" }),
      ]),
    );
    skipped["long-started"] = { result };
    const errors = gateErrors(skipped, heavyJobs, [], "full");
    assert.ok(errors.includes(`long-started: expected success, got ${result}`), result);
    for (const id of later.filter((id) => !conditionalJobs.includes(id)))
      assert.ok(errors.includes(`${id}: expected success, got skipped`), `${id} ${result}`);
    assert.ok(
      gateErrors({ ...passed, "long-started": { result } }, heavyJobs, [], "full").length,
      result,
    );
    assert.ok(gateErrors({ ...passed, "long-started": { result } }, [], [], "fast").length, result);
  }
  const { "long-started": _job, ...missing } = passed;
  assert.ok(gateErrors(missing, heavyJobs, [], "full").length);
});

// Set BASALT_CI_ORDER_BASE to a ref to prove a change to the tiers moves start order only.
test(
  "against a base ref, only `needs` lines differ, and only by long-started",
  { skip: !process.env.BASALT_CI_ORDER_BASE },
  () => {
    const base = jobsOf(
      execFileSync(
        "git",
        ["show", `${process.env.BASALT_CI_ORDER_BASE}:.github/workflows/ci.yml`],
        { encoding: "utf8", maxBuffer: 1 << 26 },
      ),
    );
    assert.deepEqual(
      Object.keys(jobs).sort(),
      [...new Set([...Object.keys(base), "long-started"])].sort(),
    );
    const without = (job: Job | undefined) => needsOf(job).filter((id) => id !== "long-started");
    for (const [id, before] of Object.entries(base)) {
      if (id === "long-started") continue;
      const { needs: _before, ...was } = before;
      const { needs: _after, ...is } = jobs[id]!;
      assert.deepEqual(is, was, id);
      assert.deepEqual(without(jobs[id]), without(before), id);
      assert.equal(
        needsOf(jobs[id]).includes("long-started"),
        id === "check" || later.includes(id),
        id,
      );
    }
  },
);
