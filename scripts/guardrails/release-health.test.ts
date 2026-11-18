import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { releaseHealth, type Deployment, type Merge } from "./release-health.ts";

// GitHub's recorded production history, 5-18 Nov: two spirals of failed releases and the normal days between.
const recorded = JSON.parse(
  readFileSync(new URL("./fixtures/production-2026-11.json", import.meta.url), "utf8"),
);
const deployments: Deployment[] = recorded.deployments.map(
  ([sha, createdAt, committedAt, state]: [string, string, string, Deployment["state"]]) => ({
    sha,
    createdAt,
    committedAt,
    state,
  }),
);
const merges: Merge[] = recorded.merges.map(([number, mergedAt]: [number, string]) => ({
  number,
  mergedAt,
}));
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
  assert.equal(now.hoursSinceLastGood, 60.9);
});

test("freezes merges 12 hours after the oldest unreleased merge", () => {
  assert.equal(at("2026-11-16T17:37:00Z").freeze, false);
  const frozen = at("2026-11-16T17:38:00Z");
  assert.equal(frozen.freeze, true);
  assert.equal(frozen.oldestUnreleasedMergeAt, "2026-11-16T05:37:37Z");
  assert.equal(frozen.unreleasedPullRequests, 27);
  assert.equal(at("2026-11-07T02:16:00Z").freeze, false);
  assert.equal(at("2026-11-07T02:17:00Z").freeze, true);
  // Without the freeze the queue kept growing for two more days.
  assert.equal(at("2026-11-18T19:00:00Z").unreleasedPullRequests, 81);
});

test("freezes when releases fail before creating a deployment", () => {
  // On 15 Nov four release runs failed and only one reached a deployment, so the line never
  // stopped; the waiting time is what shows that work had stopped reaching production.
  assert.equal(at("2026-11-16T03:07:00Z").freeze, false);
  assert.equal(at("2026-11-16T03:08:00Z").stopTheLine, false);
  assert.equal(at("2026-11-16T03:08:00Z").freeze, true);
  assert.equal(at("2026-11-16T03:40:00Z").freeze, false);
});

test("raises nothing through the normal releases of 11-15 Nov", () => {
  const start = Date.parse("2026-11-11T01:10:00Z");
  const end = Date.parse("2026-11-15T20:00:00Z");
  for (let time = start; time <= end; time += 10 * 60_000) {
    const health = releaseHealth(deployments, merges, new Date(time));
    assert.equal(health.blocker, false, new Date(time).toISOString());
  }
});

test("a deployment still in progress counts as failed only once it is stuck", () => {
  const deployment = (sha: string, createdAt: string, state: Deployment["state"]) => ({
    sha,
    createdAt,
    committedAt: createdAt,
    state,
  });
  const history: Deployment[] = [
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
  const rollback: Deployment = {
    sha: "old",
    createdAt: "2026-11-02T12:00:00Z",
    committedAt: "2026-11-01T00:00:00Z",
    state: "success",
  };
  const merged: Merge[] = [{ number: 1, mergedAt: "2026-11-01T06:00:00Z" }];
  const health = releaseHealth([rollback], merged, new Date("2026-11-02T13:00:00Z"));
  assert.equal(health.unreleasedPullRequests, 1);
  assert.equal(health.freeze, true);
});
