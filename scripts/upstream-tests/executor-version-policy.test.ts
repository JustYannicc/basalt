import assert from "node:assert/strict";
import test from "node:test";
import { executorMarkerPolicy } from "../deploy-safety/executor-marker.ts";
import { executorVersionPolicy } from "../../.upstream/apps/hosted/cloud/src/implementation/executor-version-policy.ts";

const candidate = "b".repeat(40);
const input = {
  candidate,
  attempt: "00000000-0000-4000-8000-000000000001",
  directory: "/fixture/receipts",
  policy: executorMarkerPolicy(candidate),
};

test("fresh self-host and preview setup have no production precondition", () => {
  assert.equal(executorVersionPolicy({}), undefined);
  assert.equal(executorVersionPolicy({ policy: "ambient garbage" }), undefined);
  assert.equal(executorVersionPolicy(input)?.precondition, null);
});

test("a production attempt requires a policy for its exact immutable candidate", () => {
  for (const invalid of [
    { ...input, policy: undefined },
    { ...input, policy: "not JSON" },
    { ...input, candidate: "c".repeat(40) },
    { ...input, attempt: "../other-attempt" },
    { ...input, directory: undefined },
  ])
    assert.throws(() => executorVersionPolicy(invalid), /policy is missing or invalid/);
});

test("the production command receives the exact cutover marker and transition", () => {
  const precondition = {
    transition: {
      baseGitCommit: "a".repeat(40),
      candidateGitCommit: candidate,
      baseToolsCommit: "f69c667936e4c02c75f9d7cc79fb750c230839b9",
      candidateToolsCommit: "2f4c398f3906e0570f0e25a16fa3602329baba29",
    },
    marker: "public.private_executor_settings.key=version",
    expected: "4.0.29",
  } as const;
  const policy = executorMarkerPolicy(candidate, precondition);
  assert.deepEqual(executorVersionPolicy({ ...input, policy })?.precondition, precondition);
  assert.throws(
    () => executorVersionPolicy({ ...input, policy: policy.replace("4.0.29", "4.0.28") }),
    /policy is missing or invalid/,
  );
});
