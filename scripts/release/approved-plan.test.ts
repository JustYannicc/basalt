import assert from "node:assert/strict";
import { test } from "node:test";
import { deployApproval, planDifference, planDigest, type PlanReading } from "./approved-plan.ts";

const candidate = "8e1331df0acaabf3f581fc81f8f75313523d6052";
// A plan-only of that commit, shortened; the noop row is in the plan but not printed.
const approvedPlan: PlanReading = {
  candidate,
  declared: true,
  rows: [
    { fqn: "Api", resourceType: "Cloudflare.Worker", action: "update" },
    { fqn: "AppCompiler", resourceType: "Cloudflare.Worker", action: "update" },
    { fqn: "PoolWorker", resourceType: "Cloudflare.Worker", action: "update" },
    { fqn: "PoolBackendBudget", resourceType: "Command.Exec", action: "update" },
    { fqn: "Router", resourceType: "Cloudflare.Worker", action: "noop" },
  ],
  actions: [{ fqn: "ResumeAppDomains", actionType: "Command.Action", action: "noop" }],
  created: [],
  forward: [],
};
const approved = planDigest(approvedPlan);

test("a deploy whose plan has the approved rows goes ahead, in any order", () => {
  assert.match(approved, /^[a-f0-9]{64}$/u);
  assert.equal(planDifference(approved, approvedPlan), undefined);
  assert.equal(
    planDifference(approved, { ...approvedPlan, rows: [...approvedPlan.rows].reverse() }),
    undefined,
  );
  // A noop row is not part of the plan anyone reads.
  assert.equal(
    planDifference(approved, {
      ...approvedPlan,
      rows: approvedPlan.rows.filter((row) => row.action !== "noop"),
    }),
    undefined,
  );
});

test("an extra row, a missing row and a changed action each refuse, and name this plan's rows", () => {
  const extra = {
    ...approvedPlan,
    rows: [
      ...approvedPlan.rows,
      { fqn: "AppPages", resourceType: "Cloudflare.Worker", action: "update" },
    ],
  };
  const missing = { ...approvedPlan, rows: approvedPlan.rows.slice(1) };
  const changed = {
    ...approvedPlan,
    rows: approvedPlan.rows.map((row) =>
      row.fqn === "PoolWorker" ? { ...row, action: "replace" } : row,
    ),
  };
  for (const [name, plan] of [
    ["extra", extra],
    ["missing", missing],
    ["changed", changed],
  ] as const) {
    const refusal = planDifference(approved, plan);
    assert.ok(refusal, `${name} refuses`);
    assert.ok(refusal.includes(approved), `${name}: names the approved digest`);
    assert.ok(refusal.includes(planDigest(plan)), `${name}: names this plan's digest`);
    assert.match(refusal, /nothing applied/u);
  }
  assert.match(planDifference(approved, extra)!, /AppPages Cloudflare\.Worker update/u);
  assert.match(planDifference(approved, changed)!, /PoolWorker Cloudflare\.Worker replace/u);
});

test("every write the plan prints is part of it: actions, bindings, classes and re-points", () => {
  for (const [name, plan] of [
    ["another commit", { ...approvedPlan, candidate: "0".repeat(40) }],
    ["the fleet switch", { ...approvedPlan, declared: false }],
    ["a forward re-point", { ...approvedPlan, forward: ["Router"] }],
    ["a created class", { ...approvedPlan, created: ["PoolWorker: PoolRuntimeBlue"] }],
    [
      "an action that runs",
      { ...approvedPlan, actions: [{ ...approvedPlan.actions[0]!, action: "run" }] },
    ],
    [
      "a noop row whose binding changes",
      {
        ...approvedPlan,
        rows: approvedPlan.rows.map((row) =>
          row.fqn === "Router" ? { ...row, bindings: [{ action: "update" }] } : row,
        ),
      },
    ],
  ] as const)
    assert.ok(planDifference(approved, plan), name);
});

test("a deploy without a well-formed approved digest is refused; plan-only needs none", () => {
  for (const value of [undefined, "", "  ", "not-a-digest", approved.slice(1)]) {
    const approval = deployApproval("deploy", value);
    assert.equal(approval.approved, undefined);
    assert.match(approval.refusal ?? "", /needs approved_plan/u);
  }
  assert.deepEqual(deployApproval("deploy", ` ${approved.toUpperCase()} `), { approved });
  assert.deepEqual(deployApproval("plan", undefined), {});
});
