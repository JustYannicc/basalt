import assert from "node:assert/strict";
import { test } from "node:test";
import { cleanupTarget } from "./cleanup.ts";

const repository = "fixture/basalt";
const closed = () => ({ action: "closed", repository: { full_name: repository }, pull_request: {
  number: 17, labels: [{ name: "release-update" }], head: { ref: "release-updates/home-v1", repo: { full_name: repository } },
} });
const completed = () => ({ repository: { full_name: repository }, workflow_run: {
  id: 23, name: "Release preview", status: "completed", event: "pull_request", head_branch: "release-updates/home-v1",
  head_repository: { full_name: repository }, pull_requests: [{ number: 17 }],
} });

test("closed and interrupted preview runs resolve only their exact same-repo temporary stage", () => {
  assert.deepEqual(cleanupTarget(closed(), repository), { pullRequest: 17, branch: "release-updates/home-v1" });
  assert.deepEqual(cleanupTarget(completed(), repository), { pullRequest: 17, branch: "release-updates/home-v1", runId: 23 });
  const otherRepo = closed(); otherRepo.pull_request.head.repo.full_name = "fixture/fork";
  assert.throws(() => cleanupTarget(otherRepo, repository));
  const unrelated = closed(); unrelated.pull_request.head.ref = "feature/unrelated";
  assert.throws(() => cleanupTarget(unrelated, repository));
  const push = completed(); push.workflow_run.event = "push";
  assert.throws(() => cleanupTarget(push, repository));
  const ambiguous = completed(); ambiguous.workflow_run.pull_requests.push({ number: 18 });
  assert.throws(() => cleanupTarget(ambiguous, repository));
});
