import assert from "node:assert/strict";
import { test } from "node:test";
import {
  decide,
  rehearsalCreator,
  rehearsalDescription,
  type GateInput,
  type Rehearsal,
} from "./release-gate.ts";
import { releasePathHash } from "./release-path.ts";
import { deployments, measured, root } from "./test/history.ts";

const hashes = new Map<string, string>();
const hashOf = (sha: string) => {
  if (!hashes.has(sha)) hashes.set(sha, releasePathHash(root, sha, measured));
  return hashes.get(sha)!;
};

// Every recorded production deployment, judged as the gate would have judged it at that moment.
// `rehearse` says which rehearsal statuses existed then; none did on the real days.
function replay(rehearse: (sha: string, at: string, live: string) => Rehearsal[] = () => []) {
  let lastGood: string | null = null;
  let failures = 0;
  let latestFailure: { sha: string; at: string; live: string } | null = null;
  return deployments.map((deployment) => {
    const input: GateInput = {
      candidate: deployment.sha,
      candidateHash: hashOf(deployment.sha),
      lastGood: lastGood ? { sha: lastGood, hash: hashOf(lastGood) } : null,
      consecutiveFailures: failures,
      latestFailure: latestFailure && {
        ...latestFailure,
        rehearsals: rehearse(latestFailure.sha, latestFailure.at, latestFailure.live),
      },
      rehearsals: lastGood ? rehearse(deployment.sha, deployment.createdAt, lastGood) : [],
      override: null,
    };
    const verdict = decide(input);
    if (deployment.state === "success") {
      lastGood = deployment.sha;
      failures = 0;
      latestFailure = null;
    } else {
      failures += 1;
      latestFailure = { sha: deployment.sha, at: deployment.createdAt, live: lastGood ?? "" };
    }
    return { ...deployment, pass: verdict.pass };
  });
}
let unrehearsed: ReturnType<typeof replay> | undefined;
const asRecorded = () => (unrehearsed ??= replay());

test("refuses every failed deployment of the 16-18 Nov spiral before it reaches production", () => {
  const spiral = asRecorded().filter((d) => d.createdAt > "2026-11-16T07:00:00Z");
  assert.equal(spiral.length, 12);
  assert.deepEqual(
    spiral.filter((d) => d.pass),
    [],
  );
});

test("refuses the first spiral at its first failure and 45 of the 51 failures since 6 Nov", () => {
  const judged = asRecorded().filter((d) => d.createdAt > "2026-11-06T15:16:00Z");
  const first = judged.find((d) => d.state === "failure");
  assert.deepEqual([first?.sha, first?.pass], ["7f8879f6", false]);
  const failed = judged.filter((d) => d.state === "failure");
  assert.equal(failed.length, 51);
  assert.equal(failed.filter((d) => !d.pass).length, 45);
  // The price: 22 of the 46 good releases since then changed the release path and needed a rehearsal.
  const good = judged.filter((d) => d.state === "success");
  assert.deepEqual([good.filter((d) => !d.pass).length, good.length], [22, 46]);
});

test("even with a green rehearsal for every candidate, the 16 Nov spiral stops at its third attempt", () => {
  // Suppose each candidate had been rehearsed green an hour before it went out, and production
  // still failed: the rehearsal missed something. From the second failure on, a fresh green run is
  // not enough; the rehearsal has to fail on the candidate production rejected first.
  const rehearsed = replay((sha, at, live) => [
    {
      state: "success",
      description: rehearsalDescription(hashOf(sha), live),
      createdAt: new Date(Date.parse(at) - 3_600_000).toISOString(),
      creator: rehearsalCreator,
    },
  ]).filter((d) => d.createdAt > "2026-11-16T07:00:00Z");
  assert.deepEqual(
    rehearsed.map((d) => d.pass),
    [true, true, ...Array<boolean>(10).fill(false)],
  );
});

const stopped: GateInput = {
  candidate: "candidate",
  candidateHash: "c".repeat(64),
  lastGood: { sha: "0ae42a544bebbbab3cedd0c4cfe794f48a6a784f", hash: "g".repeat(64) },
  consecutiveFailures: 2,
  latestFailure: { sha: "5f27c105", at: "2026-11-16T15:24:00Z", rehearsals: [] },
  rehearsals: [],
  override: null,
};
const green = (createdAt: string): Rehearsal => ({
  state: "success",
  description: rehearsalDescription("c".repeat(64), "0ae42a544bebbbab3cedd0c4cfe794f48a6a784f"),
  createdAt,
  creator: rehearsalCreator,
});

test("a stopped line passes the reverted release path", () => {
  assert.equal(decide({ ...stopped, candidateHash: "g".repeat(64) }).pass, true);
});

test("a stopped line needs the rehearsal to reproduce the latest failure, then pass", () => {
  const reproduced = {
    ...stopped.latestFailure!,
    rehearsals: [{ ...green("2026-11-16T15:50:00Z"), state: "failure" }],
  };
  assert.equal(decide({ ...stopped, rehearsals: [green("2026-11-16T16:00:00Z")] }).pass, false);
  const proven = { ...stopped, latestFailure: reproduced };
  assert.equal(decide({ ...proven, rehearsals: [green("2026-11-16T10:00:00Z")] }).pass, false);
  assert.equal(decide({ ...proven, rehearsals: [green("2026-11-16T16:00:00Z")] }).pass, true);
  // Before the line stops, the rehearsal of the candidate from the live commit is enough.
  const running = { ...stopped, consecutiveFailures: 1 };
  assert.equal(decide({ ...running, rehearsals: [green("2026-11-16T10:00:00Z")] }).pass, true);
});

test("only a rehearsal the Actions bot posted, for this path and live commit, counts", () => {
  const later = green("2026-11-16T16:00:00Z");
  const running = { ...stopped, consecutiveFailures: 1, latestFailure: null };
  assert.equal(decide({ ...running, rehearsals: [later] }).pass, true);
  const byPerson = { ...later, creator: "someone" };
  const otherLive = { ...later, description: rehearsalDescription("c".repeat(64), "dae3b327") };
  const failed = { ...later, state: "failure" };
  for (const rehearsal of [byPerson, otherLive, failed])
    assert.equal(decide({ ...running, rehearsals: [rehearsal] }).pass, false);
});

test("an override passes and names who gave it and why", () => {
  const verdict = decide({ ...stopped, override: { actor: "owner", reason: "planned outage" } });
  assert.deepEqual(verdict, { pass: true, reason: "overridden by owner: planned outage" });
});
