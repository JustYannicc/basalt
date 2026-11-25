import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { guard, refusal } from "./settings.ts";

const dispatch = {
  GITHUB_ACTIONS: "true",
  GITHUB_REF: "refs/heads/main",
  ROUTE_SCRATCH_STAGE: "test-route-scratch-1",
  ROUTE_SCRATCH_MODE: "deploy",
  ROUTE_SCRATCH_GO: "coordinator-2026-11-25-p2rg-1",
};

test("a dispatch on main with a known stage, mode and go text passes", () => {
  assert.equal(refusal(dispatch), undefined);
  assert.deepEqual(guard(dispatch), { stage: "test-route-scratch-1", mode: "deploy" });
  assert.equal(
    refusal({
      ...dispatch,
      ROUTE_SCRATCH_STAGE: "test-route-scratch-2",
      ROUTE_SCRATCH_MODE: "destroy",
    }),
    undefined,
  );
});

test("only the two scratch stages are accepted", () => {
  for (const stage of [
    undefined,
    "",
    "production",
    "route-scratch-1",
    "test-route-scratch-3",
    "TEST-ROUTE-SCRATCH-1",
    "test-route-scratch-1 ",
    "test-rehearsal-1",
  ])
    assert.equal(
      refusal({ ...dispatch, ROUTE_SCRATCH_STAGE: stage }),
      "route_scratch_stage_refused",
    );
});

test("only deploy, run and destroy are accepted", () => {
  for (const mode of [undefined, "", "plan", "apply", "teardown", "Deploy"])
    assert.equal(refusal({ ...dispatch, ROUTE_SCRATCH_MODE: mode }), "route_scratch_mode_refused");
});

test("the go text is required and must be the coordinator's dated form", () => {
  assert.equal(refusal({ ...dispatch, ROUTE_SCRATCH_GO: undefined }), "route_scratch_go_missing");
  assert.equal(refusal({ ...dispatch, ROUTE_SCRATCH_GO: "" }), "route_scratch_go_missing");
  for (const go of [
    "go",
    "coordinator-2026-11-25",
    "coordinator-2026-11-25-",
    "coordinator-26-11-25-p2rg",
    "coordinator-2026-13-01-p2rg",
    "coordinator-2026-02-30-p2rg",
    "integrator-2026-11-25-p2rg",
    "coordinator-2026-11-25-P2RG",
    "coordinator-2026-11-25-p2rg run",
    "coordinator-2026-11-25-p2rg;rm",
    " coordinator-2026-11-25-p2rg",
    `coordinator-2026-11-25-${"a".repeat(64)}`,
  ])
    assert.equal(refusal({ ...dispatch, ROUTE_SCRATCH_GO: go }), "route_scratch_go_malformed", go);
});

test("only main inside GitHub Actions may dispatch", () => {
  assert.equal(
    refusal({ ...dispatch, GITHUB_ACTIONS: undefined }),
    "route_scratch_outside_actions",
  );
  for (const ref of ["refs/heads/MAIN", "refs/heads/main2", "refs/tags/main", "refs/pull/1/merge"])
    assert.equal(refusal({ ...dispatch, GITHUB_REF: ref }), "route_scratch_not_main");
});

test("the first guard refuses to run once any credential is in its environment", () => {
  for (const name of ["CLOUDFLARE_API_TOKEN", "CLOUDFLARE_ACCOUNT_ID"]) {
    assert.equal(refusal({ ...dispatch, [name]: "x" }), "route_scratch_guard_saw_credential");
    // The run entry checks again after loading them, and still refuses everything else.
    assert.equal(refusal({ ...dispatch, [name]: "x" }, { credentialsLoaded: true }), undefined);
    assert.equal(
      refusal({ ...dispatch, [name]: "x", ROUTE_SCRATCH_GO: "go" }, { credentialsLoaded: true }),
      "route_scratch_go_malformed",
    );
  }
});

test("a refusal names its code only, never the value it refused", () => {
  const go = "coordinator-2026-11-25-not valid secret-ish";
  assert.throws(
    () => guard({ ...dispatch, ROUTE_SCRATCH_GO: go }),
    (error: Error) => error.message === "route_scratch_go_malformed",
  );
  const run = spawnSync(process.execPath, [new URL("./guard.ts", import.meta.url).pathname], {
    env: { PATH: process.env.PATH, ...dispatch, ROUTE_SCRATCH_GO: go },
    encoding: "utf8",
  });
  assert.notEqual(run.status, 0);
  assert.match(run.stderr, /route_scratch_go_malformed/u);
  assert.doesNotMatch(run.stderr + run.stdout, /not valid secret-ish/u);
});
