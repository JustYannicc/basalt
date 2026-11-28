// The stage's guard, and that the repo's stage-sweeping tools and this stage never take each other's.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { alchemyPreviewStateReader } from "../preview/inventory.ts";
import { isRehearsalStage, stageOwnsName } from "../release/rehearsal-stage.ts";
import { stageRepositories } from "../release/stage-teardown.ts";
import { container, prefix, profileTarget, refusal, stage, worker } from "./settings.ts";

const dispatch = {
  GITHUB_ACTIONS: "true",
  GITHUB_REF: "refs/heads/main",
  GITHUB_EVENT_NAME: "workflow_dispatch",
  EMULATED_STAGE: "test-emulated-upstream",
  EMULATED_MODE: "deploy",
  EMULATED_GO: "coordinator-2026-11-25-load-proof-1",
};
const key = "k".repeat(43);
const rehearsals = ["test-rehearsal-1", "test-rehearsal-9", "test-rehearsal-2026"];
const previews = ["test-pr-1", "test-pr-1951"];

test("a dispatch needs main, the one stage, a known mode and the coordinator's go", () => {
  assert.equal(stage, "test-emulated-upstream");
  assert.equal(prefix, "basalt-emulated-upstream");
  assert.equal(refusal(dispatch), undefined);
  for (const other of [
    ...rehearsals,
    ...previews,
    "emulated-upstream",
    "production",
    "scale-180",
    "",
  ])
    assert.equal(
      refusal({ ...dispatch, EMULATED_STAGE: other }),
      "emulated_upstream_stage_refused",
      other,
    );
  assert.equal(
    refusal({ ...dispatch, GITHUB_REF: "refs/heads/MAIN" }),
    "emulated_upstream_not_main",
  );
  assert.equal(
    refusal({ ...dispatch, GITHUB_ACTIONS: undefined }),
    "emulated_upstream_outside_actions",
  );
  assert.equal(
    refusal({ ...dispatch, EMULATED_MODE: "run" }),
    "emulated_upstream_mode_expected_deploy_check_profile_destroy_or_expire",
  );
  for (const go of [
    undefined,
    "",
    "coordinator-2026-11-25-",
    "coordinator-1999-11-25-x",
    "go",
    `coordinator-2026-11-25-${"x".repeat(97)}`,
    "coordinator-2026-11-25-a b",
  ])
    assert.equal(
      refusal({ ...dispatch, EMULATED_GO: go }),
      "emulated_upstream_go_missing_or_malformed",
      String(go),
    );
});

test("only the schedule expires, and it needs no go; a dispatch cannot expire", () => {
  const scheduled = {
    ...dispatch,
    GITHUB_EVENT_NAME: "schedule",
    EMULATED_MODE: "expire",
    EMULATED_GO: undefined,
  };
  assert.equal(refusal(scheduled), undefined);
  assert.equal(
    refusal({ ...dispatch, EMULATED_MODE: "expire" }),
    "emulated_upstream_dispatch_expected_deploy_check_profile_or_destroy",
  );
  for (const mode of ["deploy", "check", "destroy"])
    assert.equal(
      refusal({ ...scheduled, EMULATED_MODE: mode }),
      "emulated_upstream_schedule_expected_expire",
      mode,
    );
  assert.equal(
    refusal({ ...scheduled, EMULATED_MODE: "run" }),
    "emulated_upstream_mode_expected_deploy_check_profile_destroy_or_expire",
  );
});

test("the guard runs before credentials; only deploy and check need the key once they are loaded", () => {
  assert.equal(
    refusal({ ...dispatch, CLOUDFLARE_API_TOKEN: "x" }),
    "emulated_upstream_guard_saw_credential",
  );
  const loaded = { credentialsLoaded: true };
  assert.equal(refusal(dispatch, loaded), "emulated_upstream_key_missing_or_malformed");
  assert.equal(refusal({ ...dispatch, EMULATED_UPSTREAM_KEY: key }, loaded), undefined);
  assert.equal(
    refusal({ ...dispatch, EMULATED_MODE: "check", EMULATED_UPSTREAM_KEY: "short" }, loaded),
    "emulated_upstream_key_missing_or_malformed",
  );
  assert.equal(refusal({ ...dispatch, EMULATED_MODE: "destroy" }, loaded), undefined);
});

const profiling = {
  ...dispatch,
  EMULATED_MODE: "profile",
  GITHUB_RUN_ATTEMPT: "1",
  EMULATED_PROFILE: "b",
  EMULATED_SHARE_429: "0.5",
  EMULATED_LATENCY_MS: "0",
};

test("profile takes exactly profile b's two settings within the mock's own bounds, and the key", () => {
  assert.equal(refusal(profiling), undefined);
  assert.deepEqual(profileTarget(profiling), { rateLimitRate: 0.5, latencyMs: 0 });
  // The restore is the same mode with zeros.
  const zeros = { ...profiling, EMULATED_SHARE_429: "0", EMULATED_LATENCY_MS: "0" };
  assert.equal(refusal(zeros), undefined);
  assert.deepEqual(profileTarget(zeros), { rateLimitRate: 0, latencyMs: 0 });
  assert.deepEqual(
    profileTarget({ ...profiling, EMULATED_SHARE_429: "1", EMULATED_LATENCY_MS: "30000" }),
    {
      rateLimitRate: 1,
      latencyMs: 30_000,
    },
  );
  for (const share of ["", "1.5", "1e-3", "-0.1", "abc", " 0.5", "0x1", "NaN"])
    assert.equal(
      refusal({ ...profiling, EMULATED_SHARE_429: share }),
      "emulated_upstream_profile_settings_out_of_bounds",
      share,
    );
  for (const latency of ["", "30001", "1.5", "-1", "1e3", "abc", "0100", "01000000"])
    assert.equal(
      refusal({ ...profiling, EMULATED_LATENCY_MS: latency }),
      "emulated_upstream_profile_settings_out_of_bounds",
      latency,
    );
  // Profile a never has faults: the mock has no control for it.
  for (const name of ["a", "", "B", "c"])
    assert.equal(
      refusal({ ...profiling, EMULATED_PROFILE: name }),
      "emulated_upstream_profile_expected_b",
      name,
    );
  assert.equal(
    refusal({ ...profiling, EMULATED_GO: "" }),
    "emulated_upstream_go_missing_or_malformed",
  );
  const loaded = { credentialsLoaded: true };
  assert.equal(refusal(profiling, loaded), "emulated_upstream_key_missing_or_malformed");
  assert.equal(refusal({ ...profiling, EMULATED_UPSTREAM_KEY: key }, loaded), undefined);
});

test("every profile setting is a fresh dispatch: a re-run of one is refused", () => {
  for (const attempt of ["2", "3", "", undefined])
    assert.equal(
      refusal({ ...profiling, GITHUB_RUN_ATTEMPT: attempt }),
      "emulated_upstream_profile_rerun_refused",
      String(attempt),
    );
});

test("no other mode takes profile settings, so none can look as if it set them", () => {
  for (const mode of ["deploy", "check", "destroy"])
    for (const [name, value] of [
      ["EMULATED_SHARE_429", "0.5"],
      ["EMULATED_LATENCY_MS", "1000"],
    ])
      assert.equal(
        refusal({ ...dispatch, EMULATED_MODE: mode, [name]: value }),
        "emulated_upstream_profile_settings_without_profile_mode",
        `${mode} ${name}`,
      );
  // The workflow's own default for the profile input is b, so it alone is no setting.
  assert.equal(refusal({ ...dispatch, EMULATED_PROFILE: "b" }), undefined);
});

test("no rehearsal or preview tool treats the stage or its names as its own", async () => {
  assert.equal(isRehearsalStage(stage), false);
  for (const name of [worker, container, `${prefix}-test-rehearsal-1-pool-runtime-blue`]) {
    for (const rehearsal of [...rehearsals, stage]) {
      assert.equal(stageOwnsName(name, rehearsal), false, `${rehearsal} would take ${name}`);
      assert.deepEqual(stageRepositories([`acct/${name}`], "acct", rehearsal), []);
    }
  }
  let ran = false;
  const reader = alchemyPreviewStateReader({
    command: () => {
      ran = true;
      throw new Error("no state command may run");
    },
    environment: {},
  });
  await assert.rejects(reader.read(stage), /restricted to PR stages/u);
  assert.equal(ran, false);
});

test("the workflow offers only the stage; the key reaches only the dispatched job's deploy and check", () => {
  const workflow = readFileSync(
    new URL("../../.github/workflows/emulated-upstream.yml", import.meta.url),
    "utf8",
  );
  const triggers = /^on:\n((?: {2}.*\n|\n)*)/mu.exec(workflow)?.[1] ?? "";
  assert.deepEqual(
    [...triggers.matchAll(/^ {2}([a-z_]+):/gmu)].map((match) => match[1]),
    ["workflow_dispatch", "schedule"],
  );
  assert.match(workflow, /^\s+options: \[test-emulated-upstream\]$/mu);
  for (const other of [...rehearsals, ...previews]) assert.ok(!workflow.includes(other), other);
  const [dispatched, scheduled] = workflow.split(/^ {2}expire:\n/mu);
  assert.match(dispatched, /^ {4}environment: emulated-upstream$/mu);
  assert.equal(dispatched.match(/secrets\.EMULATED_UPSTREAM_KEY/gu)?.length, 1);
  assert.match(
    dispatched,
    /\(inputs\.mode == 'deploy' \|\| inputs\.mode == 'check' \|\| inputs\.mode == 'profile'\) && secrets\.EMULATED_UPSTREAM_KEY/u,
  );
  // Profile's settings are plain inputs; only profile b is offered, and the job reads them as env.
  assert.match(workflow, /^\s+options: \[deploy, check, profile, destroy\]$/mu);
  assert.match(workflow, /^\s+options: \[b\]$/mu);
  for (const [input, name] of [
    ["profile", "EMULATED_PROFILE"],
    ["share429", "EMULATED_SHARE_429"],
    ["latency", "EMULATED_LATENCY_MS"],
  ]) {
    assert.match(workflow, new RegExp(`^ {6}${input}:$`, "mu"), input);
    assert.match(
      dispatched,
      new RegExp(`^ {6}${name}: \\$\\{\\{ inputs\\.${input} \\}\\}$`, "mu"),
      name,
    );
  }
  // The guard reads the attempt GitHub gives every run, so a re-run is refused.
  assert.doesNotMatch(dispatched, /GITHUB_RUN_ATTEMPT:/u);
  assert.doesNotMatch(scheduled, /EMULATED_UPSTREAM_KEY|environment:/u);
  // Dispatches and the expiry queue in separate groups, so the hourly run never cancels a
  // pending dispatch; only the expiry may read the workflow's runs.
  assert.doesNotMatch(workflow, /^concurrency:/mu);
  assert.match(dispatched, /^ {4}concurrency:\n {6}group: emulated-upstream\n/mu);
  assert.match(scheduled, /^ {4}concurrency:\n {6}group: emulated-upstream-expiry\n/mu);
  assert.doesNotMatch(dispatched, /actions: read/u);
  assert.match(scheduled, /^ {6}actions: read$/mu);
  assert.match(
    scheduled,
    /run: node scripts\/emulated-upstream\/dispatch-busy\.mjs[\s\S]*if: steps\.dispatches\.outputs\.skip == 'false'\n {8}run: node scripts\/emulated-upstream\/run\.mjs/u,
  );
});
