import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { decide, rehearsalDescription, type GateInput } from "./release-gate.ts";
import { releasePathHash } from "./release-path.ts";

const root = new URL("../..", import.meta.url).pathname;
const recorded = JSON.parse(
  readFileSync(new URL("./fixtures/production-2026-11.json", import.meta.url), "utf8"),
);
const deployments: { sha: string; createdAt: string; state: string }[] = recorded.deployments.map(
  ([sha, createdAt, , state]: string[]) => ({ sha, createdAt, state }),
);
const present = (sha: string) =>
  spawnSync("git", ["cat-file", "-e", `${sha}^{commit}`], { cwd: root }).status === 0;
const needsHistory = {
  skip: deployments.every((d) => present(d.sha)) ? false : "needs the full repository history",
};
// Pinned to the list the numbers were measured with, like release-path.test.ts.
const measured = [
  "alchemy.run.ts",
  "release-declarations.json",
  "patches/*alchemy*",
  "scripts/release-barrier/**",
  "scripts/release-phases/**",
  "scripts/release-merge/**",
  "scripts/deploy-safety/**",
  "scripts/deploy-main/**",
  "scripts/deploy.ts",
  ".github/workflows/deploy.yml",
  ".github/workflows/release-main.yml",
  ".github/workflows/release-manual.yml",
  ".github/workflows/release-rollback.yml",
  ".github/workflows/pool-runtime-provision.yml",
];

// Every recorded production deployment, judged as the gate would have judged it at that moment.
// No rehearsal stage existed then, so no candidate had a rehearsal status.
let replayed: ReturnType<typeof judge> | undefined;
const replay = () => (replayed ??= judge());
function judge() {
  const hash = new Map<string, string>();
  const hashOf = (sha: string) => {
    if (!hash.has(sha)) hash.set(sha, releasePathHash(root, sha, measured));
    return hash.get(sha)!;
  };
  let lastGood: string | null = null;
  let failures = 0;
  let latestFailureAt: string | null = null;
  return deployments.map((deployment) => {
    const input: GateInput = {
      candidate: deployment.sha,
      candidateHash: hashOf(deployment.sha),
      lastGood: lastGood ? { sha: lastGood, hash: hashOf(lastGood) } : null,
      consecutiveFailures: failures,
      latestFailureAt,
      rehearsals: [],
      override: null,
    };
    const verdict = decide(input);
    if (deployment.state === "success") {
      lastGood = deployment.sha;
      failures = 0;
      latestFailureAt = null;
    } else {
      failures += 1;
      latestFailureAt = deployment.createdAt;
    }
    return { ...deployment, pass: verdict.pass };
  });
}

test(
  "refuses every failed deployment of the 16-18 Nov spiral before it reaches production",
  needsHistory,
  () => {
    const spiral = replay().filter((d) => d.createdAt > "2026-11-16T07:00:00Z");
    assert.equal(spiral.length, 12);
    assert.deepEqual(
      spiral.filter((d) => d.pass),
      [],
    );
  },
);

test(
  "refuses the first spiral at its first failure and 45 of the 51 failures since 6 Nov",
  needsHistory,
  () => {
    const judged = replay().filter((d) => d.createdAt > "2026-11-06T15:16:00Z");
    const first = judged.find((d) => d.state === "failure");
    assert.deepEqual([first?.sha, first?.pass], ["7f8879f6", false]);
    const failed = judged.filter((d) => d.state === "failure");
    assert.equal(failed.length, 51);
    assert.equal(failed.filter((d) => !d.pass).length, 45);
    // The price: 22 of the 46 good releases since then changed the release path and needed a rehearsal.
    const good = judged.filter((d) => d.state === "success");
    assert.deepEqual([good.filter((d) => !d.pass).length, good.length], [22, 46]);
  },
);

const stopped: GateInput = {
  candidate: "candidate",
  candidateHash: "c".repeat(64),
  lastGood: { sha: "0ae42a544bebbbab3cedd0c4cfe794f48a6a784f", hash: "g".repeat(64) },
  consecutiveFailures: 2,
  latestFailureAt: "2026-11-16T15:24:00Z",
  rehearsals: [],
  override: null,
};
const green = (createdAt: string) => ({
  state: "success",
  description: rehearsalDescription("c".repeat(64), "0ae42a544bebbbab3cedd0c4cfe794f48a6a784f"),
  createdAt,
});

test("a stopped line passes the reverted release path", () => {
  assert.equal(decide({ ...stopped, candidateHash: "g".repeat(64) }).pass, true);
});

test("a stopped line needs a rehearsal newer than the latest failure", () => {
  assert.equal(decide({ ...stopped, rehearsals: [green("2026-11-16T10:00:00Z")] }).pass, false);
  assert.equal(decide({ ...stopped, rehearsals: [green("2026-11-16T16:00:00Z")] }).pass, true);
  // Before the line stops, the rehearsal of the candidate from the live commit is enough.
  const running = { ...stopped, consecutiveFailures: 1 };
  assert.equal(decide({ ...running, rehearsals: [green("2026-11-16T10:00:00Z")] }).pass, true);
});

test("a rehearsal from another live commit or of another path does not count", () => {
  const other = {
    ...green("2026-11-16T16:00:00Z"),
    description: rehearsalDescription("c".repeat(64), "dae3b327"),
  };
  assert.equal(decide({ ...stopped, rehearsals: [other] }).pass, false);
  const failed = { ...green("2026-11-16T16:00:00Z"), state: "failure" };
  assert.equal(decide({ ...stopped, rehearsals: [failed] }).pass, false);
});

test("an override passes and names who gave it and why", () => {
  const verdict = decide({ ...stopped, override: { actor: "owner", reason: "planned outage" } });
  assert.deepEqual(verdict, { pass: true, reason: "overridden by owner: planned outage" });
});
