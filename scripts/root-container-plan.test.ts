import assert from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { discoverRootContainerPlanProof } from "./architecture/native-stack.ts";

test("a plan right after an apply leaves the root container alone", { timeout: 40_000 }, () => {
  const proof = discoverRootContainerPlanProof(fileURLToPath(new URL("..", import.meta.url)));
  assert.deepEqual(
    { failed: proof.failed, error: proof.error },
    { failed: undefined, error: undefined },
  );
  assert.ok(proof.resources > 50, "the whole stack is planned, not a part of it");
  assert.ok(proof.hosted.includes("PoolContainer"));
  // The case that made the row: the pool Worker also binds a class another Worker hosts, and the
  // platform returns a namespace for that binding too.
  assert.ok(
    proof.recorded.some((name) => !proof.hosted.includes(name)),
    "the pool Worker records a class it does not host",
  );
  // The planner asks with the other Worker's name resolved and, while it follows the cycle with
  // the container, with that name unresolved. Both answers have to be there.
  assert.ok(proof.unresolved.includes(false), "the provider was asked with every name resolved");
  assert.ok(proof.unresolved.includes(true), "the provider was asked inside the cycle");
  assert.equal(proof.unresolved.length, proof.readable.length);
  assert.deepEqual(
    proof.readable.filter((answer) => !answer),
    [],
    "the installed Worker provider keeps the pool Worker's own namespaces readable",
  );
  // An update of this row modifies the container application and starts a rollout, which moves
  // its version: the pool's own restart then refuses.
  assert.deepEqual(
    proof.afterApply.filter((row) => row.id === "PoolContainer"),
    [],
    "the root container still plans as changed",
  );
});
