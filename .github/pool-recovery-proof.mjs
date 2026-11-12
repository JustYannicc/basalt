import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { globSync, readFileSync, writeFileSync } from "node:fs";
import { execFileSync, spawnSync } from "node:child_process";

const mode = process.env.PROOF_CASE;
const red = mode === "red";
const candidate = "a77d1dc43f88ac081dbca0a4705623067311c2cf";
const spec = ".upstream/e2e/tests/pool-account-recovery.spec.ts";
const hash = (path) => createHash("sha256").update(readFileSync(path)).digest("hex");
const fixedSpecSha256 = hash(spec);
if (red)
  execFileSync("git", ["apply", "../.github/pool-recovery-repro-red.patch"], { cwd: ".upstream" });
const patterns =
  mode === "affected"
    ? [
        [
          execFileSync(
            "node",
            [
              "scripts/ci/e2e-pattern.ts",
              "pool-account-recovery:recovery-through-cloud-s-real-provisioning-queue",
            ],
            { encoding: "utf8" },
          ).trim(),
          true,
        ],
        [
          execFileSync(
            "node",
            [
              "scripts/ci/e2e-pattern.ts",
              "pool-account-recovery:atomic-pool-setup-with-ordinary-cron-triggers",
            ],
            { encoding: "utf8" },
          ).trim(),
          false,
        ],
      ]
    : [
        [
          "^Cloud pool account recovery queues one owner job and preserves permissions and backoff$",
          true,
        ],
      ];
const exits = [];
for (const [pattern, manual] of patterns) {
  const result = spawnSync(
    "bun",
    [
      "run",
      "--cwd",
      ".upstream",
      "e2e:cloud",
      "--test-name",
      pattern,
      ...(manual ? ["--manual-cron"] : []),
      "--workers",
      "1",
    ],
    {
      stdio: "inherit",
      env: { ...process.env, CI: "true", BASALT_E2E_POOL_SETUP: "1" },
    },
  );
  exits.push(result.status);
  assert.equal(result.status, red ? 1 : 0, "Unexpected scenario exit status");
}
const reports = globSync(".generated/e2e-evidence/**/results.json").map((file) =>
  JSON.parse(readFileSync(file, "utf8")),
);
assert.equal(
  reports.length,
  mode === "affected" ? 2 : 1,
  "Each invocation must retain one result report",
);
const failures = reports.reduce((sum, report) => sum + report.numFailedTests, 0);
const passes = reports.reduce((sum, report) => sum + report.numPassedTests, 0);
assert.equal(failures, red ? 1 : 0);
assert.equal(passes, red ? 0 : mode === "affected" ? 3 : 1);
if (red) {
  const failed = reports
    .flatMap((report) => report.testResults.flatMap((suite) => suite.assertionResults))
    .filter((result) => result.status === "failed");
  assert.equal(failed.length, 1);
  assert.match(failed[0].fullName, /Cloud pool account recovery queues one owner job/);
  assert(
    failed[0].failureMessages.some((message) =>
      /AssertionError: expected .*to deeply equal/s.test(message),
    ),
    "Must fail the original exact queue assertion",
  );
  const milestones = globSync(".generated/e2e-evidence/**/pool-recovery-race-*.json")
    .map((file) => JSON.parse(readFileSync(file, "utf8")))
    .filter((record) => record.completed.length);
  assert.equal(milestones.length, 1);
  const [{ before, completed }] = milestones;
  assert.equal(before.filter((job) => job.ready).length, 1);
  assert.equal(before.filter((job) => job.deferred).length, 4);
  assert.equal(completed.length, 1);
  assert.equal(completed[0].status, "succeeded");
  assert.equal(completed[0].attempts, 1);
  assert(before.some((job) => job.id === completed[0].id && job.ready));
}
writeFileSync(
  "proof-result.json",
  JSON.stringify(
    {
      candidate,
      workflowHead: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
      mode,
      fixedSpecSha256,
      effectiveSpecSha256: hash(spec),
      carrySha256: hash("patches/0547-pool-recovery-fixture-race.patch"),
      exits,
      passes,
      failures,
      expectedRed: red,
    },
    null,
    2,
  ) + "\n",
);
console.log(
  `Verified ${red ? "expected exact-assertion red" : "green"} proof: ${passes} passed, ${failures} failed.`,
);
