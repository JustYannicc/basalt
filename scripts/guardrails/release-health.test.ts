import assert from "node:assert/strict";
import { test } from "node:test";
import { releaseHealth, type Deployment, type Merge } from "./release-health.ts";
import { deployments, merges } from "./test/history.ts";

const at = (time: string) => releaseHealth(deployments, merges, new Date(time));

test("stops the line at the second consecutive failed deployment of the 6-9 Nov spiral", () => {
  assert.equal(at("2026-11-06T20:02:00Z").stopTheLine, false);
  assert.equal(at("2026-11-06T20:04:00Z").consecutiveFailures, 2);
  assert.equal(at("2026-11-06T20:04:00Z").stopTheLine, true);
  // Without the stop, 22 more failed deployments followed before the next good one.
  assert.equal(at("2026-11-09T20:00:00Z").consecutiveFailures, 24);
});

test("stops the line at the second consecutive failed deployment of the 16-18 Nov spiral", () => {
  assert.equal(at("2026-11-16T15:23:00Z").stopTheLine, false);
  const stopped = at("2026-11-16T15:25:00Z");
  assert.equal(stopped.stopTheLine, true);
  assert.deepEqual(stopped.lastGood, { sha: "0ae42a54", at: "2026-11-16T06:06:42Z" });
  const now = at("2026-11-18T19:00:00Z");
  assert.equal(now.consecutiveFailures, 12);
  assert.equal(now.failingSince, "2026-11-16T08:17:27Z");
  assert.equal(now.latestFailureAt, "2026-11-18T14:46:22Z");
  assert.equal(now.hoursSinceLastGood, 60.9);
});

test("freezes merges 12 hours after the oldest unreleased merge", () => {
  assert.equal(at("2026-11-16T19:28:00Z").freeze, false);
  const frozen = at("2026-11-16T19:29:00Z");
  assert.equal(frozen.freeze, true);
  assert.equal(frozen.oldestUnreleasedMergeAt, "2026-11-16T07:28:34Z");
  assert.equal(frozen.unreleasedPullRequests, 26);
  assert.equal(at("2026-11-07T04:48:00Z").freeze, false);
  assert.equal(at("2026-11-07T04:49:00Z").freeze, true);
  // Without the freeze the queue kept growing for two more days.
  assert.equal(at("2026-11-18T19:00:00Z").unreleasedPullRequests, 79);
});

test("counts the released batch's own pull requests as released", () => {
  // GitHub stamps a batch pull request merged 1-3 s after its merge commit. Right after the
  // 16 Nov 06:06 release nothing waits.
  assert.equal(at("2026-11-16T06:10:00Z").unreleasedPullRequests, 0);
  const released: Deployment[] = [deployments.find((d) => d.sha === "0ae42a54")!];
  const quiet = merges.filter((merge) => merge.mergedAt < "2026-11-16T06:06:42Z");
  assert.equal(releaseHealth(released, quiet, new Date("2026-11-16T19:00:00Z")).freeze, false);
});

test("raises nothing through the normal releases of 11-16 Nov", () => {
  const start = Date.parse("2026-11-11T01:10:00Z");
  const end = Date.parse("2026-11-16T15:20:00Z");
  for (let time = start; time <= end; time += 10 * 60_000) {
    const health = releaseHealth(deployments, merges, new Date(time));
    assert.equal(health.blocker, false, new Date(time).toISOString());
  }
});

const deployment = (sha: string, createdAt: string, state: Deployment["state"]): Deployment => ({
  sha,
  createdAt,
  committedAt: createdAt,
  state,
});

test("a deployment still in progress counts as failed only once it is stuck", () => {
  const history = [
    deployment("a", "2026-11-01T00:00:00Z", "success"),
    deployment("b", "2026-11-01T01:00:00Z", "failure"),
    deployment("c", "2026-11-01T02:00:00Z", "pending"),
  ];
  assert.equal(releaseHealth(history, [], new Date("2026-11-01T03:00:00Z")).consecutiveFailures, 1);
  const stuck = releaseHealth(history, [], new Date("2026-11-01T06:00:00Z"));
  assert.equal(stuck.consecutiveFailures, 2);
  assert.equal(stuck.lastGood?.sha, "a");
});

test("work merged after a rollback's commit stays unreleased", () => {
  const rollback = { ...deployment("old", "2026-11-02T12:00:00Z", "success") };
  rollback.committedAt = "2026-11-01T00:00:00Z";
  const merged: Merge[] = [{ number: 1, mergedAt: "2026-11-01T06:00:00Z" }];
  const health = releaseHealth([rollback], merged, new Date("2026-11-02T13:00:00Z"));
  assert.equal(health.unreleasedPullRequests, 1);
  assert.equal(health.freeze, true);
});
